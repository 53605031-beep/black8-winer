/**
 * 约球8 · 球局核心操作云函数
 *
 * 所有涉及约局状态变更的操作都在此云函数中执行：
 * - OPENID 从云端获取，无法伪造
 * - 安全校验在服务端完成，客户端无法绕过
 *
 * action 类型：
 *   join             加入球局
 *   leave            退出球局
 *   confirm          发起人确认比赛开始
 *   submitResult     提交比赛结果选择
 *   verifyLocation  校验位置
 *   publish          发布新球局（与 join 同级）
 *   close            关闭异常/过期球局并退回本场冻结约豆
 *   cancelByVenueOwner 商家取消本店球局并退回本场冻结约豆
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 约豆常量（与 utils/cloudDB.js 保持一致）
const YUEDOU_INITIAL = 10000;
const YUEDOU_FROZEN  = 500;
const YUEDOU_WINNER  = 420;   // 赢家获得
const YUEDOU_LOSER   = -500;  // 输家损失
const YUEDOU_SYSTEM  = 80;     // 系统抽成
const PLAYING_CLOSE_AFTER_MS = 6 * 60 * 60 * 1000;

// 积分常量
const SCORE_CREATE_MATCH  = 5;
const SCORE_JOIN_MATCH    = 3;
const SCORE_COMPLETE_MATCH = 2;

// 辅助函数：服务端获取用户数据（云函数内用 openid 查库）
async function getUserByOpenid(openid) {
  const res = await db.collection("yueqiu8_users").where({ openid }).get();
  return res.data[0] || null;
}

// 辅助函数：服务端获取球局数据
async function getMatch(matchId) {
  const res = await db.collection("matches").doc(matchId).get();
  return res.data || null;
}

// 辅助函数：添加通知
async function addNotice({ type, targetOpenid, matchId, content, venueId }) {
  await db.collection("notices").add({
    data: {
      type,
      targetOpenid,
      matchId: matchId || null,
      venueId: venueId || null,
      content,
      isRead: false,
      createdAt: db.serverDate()
    }
  });
}

// 辅助函数：记录约豆变动
async function addScoreRecord(userId, type, amount, venueId, matchId) {
  await db.collection("score_records").add({
    data: {
      userId,
      type,
      amount,
      venueId: venueId || null,
      matchId: matchId || null,
      createdAt: db.serverDate()
    }
  });
}

// 辅助函数：记录球房访问
async function recordVenueAccess(userId, venueId, matchId) {
  const existing = await db.collection("venue_access")
    .where({ userId, venueId })
    .get();

  if (existing.data && existing.data.length > 0) {
    await db.collection("venue_access").doc(existing.data[0]._id).update({
      data: {
        accessAt: db.serverDate(),
        lastMatchId: matchId,
        visitCount: _.inc(1)
      }
    });
  } else {
    await db.collection("venue_access").add({
      data: {
        userId,
        venueId,
        firstAccessAt: db.serverDate(),
        accessAt: db.serverDate(),
        lastMatchId: matchId,
        visitCount: 1
      }
    });
  }
}

// 辅助函数：记录比赛参与（活跃统计）
async function recordMatchParticipation(openid, matchId, isHost = false) {
  const today = _todayStr();
  const weekStart = _weekStartStr();
  const monthStart = _monthStartStr();

  const user = await getUserByOpenid(openid);
  if (!user) return;

  let weeklyMatches = (user.weeklyMatches || 0) + 1;
  let monthlyMatches = (user.monthlyMatches || 0) + 1;

  if ((user.weeklyResetAt || "") < weekStart) weeklyMatches = 1;
  if ((user.monthlyResetAt || "") < monthStart) monthlyMatches = 1;

  const scoreGain = isHost ? SCORE_CREATE_MATCH : SCORE_JOIN_MATCH;

  await db.collection("yueqiu8_users").where({ openid }).update({
    data: {
      score: _.inc(scoreGain),
      weeklyMatches,
      monthlyMatches,
      weeklyResetAt: (user.weeklyResetAt || "") < weekStart ? weekStart : user.weeklyResetAt,
      monthlyResetAt: (user.monthlyResetAt || "") < monthStart ? monthStart : user.monthlyResetAt,
      weeklyClaimed: (user.weeklyResetAt || "") < weekStart ? false : user.weeklyClaimed,
      monthlyClaimed: (user.monthlyResetAt || "") < monthStart ? false : user.monthlyClaimed
    }
  });
}

// 辅助函数：记录完成比赛积分
async function recordMatchComplete(openid) {
  await db.collection("yueqiu8_users").where({ openid }).update({
    data: { score: _.inc(SCORE_COMPLETE_MATCH) }
  });
}

// 辅助函数：Haversine 距离计算
function _calcDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (deg) => deg * (Math.PI / 180);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function _todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
function _weekStartStr() {
  const n = new Date();
  n.setHours(0, 0, 0, 0);
  const day = n.getDay() || 7;
  n.setDate(n.getDate() - day + 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
function _monthStartStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-01`;
}

function getUniqueParticipantOpenids(match) {
  const ids = [];
  const seen = new Set();
  const add = (openid) => {
    if (openid && !seen.has(openid)) {
      seen.add(openid);
      ids.push(openid);
    }
  };
  add(match.hostOpenid);
  (match.participants || []).forEach((p) => add(p.openid));
  return ids;
}

function getParticipantByOpenid(participants, openid) {
  return (participants || []).find((p) => p.openid === openid) || null;
}

function buildFrozenRefunds(match) {
  const refunds = new Map();
  (match.participants || []).forEach((p) => {
    const frozen = Number(p.yuedouFrozen || 0);
    if (p.openid && frozen > 0) {
      refunds.set(p.openid, (refunds.get(p.openid) || 0) + frozen);
    }
  });
  return Array.from(refunds.entries()).map(([openid, amount]) => ({ openid, amount }));
}

function clearParticipantFrozen(participants) {
  return (participants || []).map((p) => ({ ...p, yuedouFrozen: 0 }));
}

function buildSettlementPlan(match, participants) {
  const choices = {};
  participants.forEach((p) => { choices[p.openid] = p.resultChoice; });

  const hostChoice = choices[match.hostOpenid] || "";
  const joinOpenid = participants.map((p) => p.openid).find((o) => o !== match.hostOpenid);
  const joinChoice = choices[joinOpenid] || "";

  let winnerId = null, loserId = null;
  if (hostChoice === "win" && joinChoice === "lose") {
    winnerId = match.hostOpenid; loserId = joinOpenid;
  } else if (hostChoice === "lose" && joinChoice === "win") {
    winnerId = joinOpenid; loserId = match.hostOpenid;
  } else {
    throw new Error("比赛结果不一致，不能结算");
  }

  const winner = getParticipantByOpenid(participants, winnerId);
  const loser = getParticipantByOpenid(participants, loserId);
  const winnerFrozen = Number((winner && winner.yuedouFrozen) || 0);
  const loserFrozen = Number((loser && loser.yuedouFrozen) || 0);
  if (winnerFrozen <= 0 || loserFrozen <= 0) throw new Error("冻结约豆数据异常，不能结算");

  return {
    winnerId,
    loserId,
    winnerFrozen,
    loserFrozen,
    winnerYuedouInc: winnerFrozen + YUEDOU_WINNER,
    winnerFrozenInc: -winnerFrozen,
    loserYuedouInc: 0,
    loserFrozenInc: -loserFrozen,
    loserSystemInc: YUEDOU_SYSTEM
  };
}

function canForceClosePlaying(match, nowMs) {
  // 老数据可能没有 startedAt，保持原页面策略：允许异常关闭并退款。
  if (!match.startedAt) return true;
  const startedAtMs = new Date(match.startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) return true;
  return nowMs - startedAtMs > PLAYING_CLOSE_AFTER_MS;
}

async function getUserDocInTransaction(transaction, openid) {
  const res = await transaction.get(db.collection("yueqiu8_users").where({ openid }));
  const user = res.data && res.data[0];
  if (!user) throw new Error("用户不存在，请先登录");
  return user;
}

async function refundFrozenInTransaction(transaction, match) {
  const refunds = buildFrozenRefunds(match);
  for (const item of refunds) {
    const user = await getUserDocInTransaction(transaction, item.openid);
    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: {
        yuedou: _.inc(item.amount),
        yuedouFrozen: _.inc(-item.amount)
      }
    });
  }
  return refunds;
}

// ── 发布球局 ───────────────────────────────────────────────
async function doPublish(openid, matchData) {
  const headcountTarget = matchData.headcountTarget || 2;
  if (headcountTarget < 2) throw new Error("每局至少需要2人");
  if (!matchData.startAt) throw new Error("请选择开局时间");
  if (!matchData.venueId) throw new Error("请选择球房");

  let matchId = null;
  await db.runTransaction(async (transaction) => {
    const user = await getUserDocInTransaction(transaction, openid);
    const nickname = user.nickname || "匿名用户";
    const avatar = user.avatarUrl || "";
    const yuedou = user.yuedou ?? YUEDOU_INITIAL;

    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法发起约局");

    const matchRes = await transaction.add(db.collection("matches"), {
      data: {
        ...matchData,
        hostOpenid: openid,
        hostNickname: nickname,
        participants: [{
          openid,
          nickname,
          avatar,
          score: user.score || 0,
          yuedouFrozen: YUEDOU_FROZEN,
          resultChoice: null,
          locationVerified: false,
          locationVerifiedAt: null
        }],
        headcountJoined: 1,
        status: "recruiting",
        createdAt: db.serverDate()
      }
    });
    matchId = matchRes._id;

    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  });

  // 记录球房访问失败不影响发布成功的资金事务。
  if (matchData.venueId) {
    try { await recordVenueAccess(openid, matchData.venueId, matchId); } catch (_) {}
  }

  return { code: "ok", matchId };
}

// ── 加入球局 ───────────────────────────────────────────────
async function doJoin(openid, matchId) {
  let joinResult = { code: "ok" };
  let venueId = null;

  await db.runTransaction(async (transaction) => {
    const user = await getUserDocInTransaction(transaction, openid);
    const yuedou = user.yuedou ?? YUEDOU_INITIAL;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法加入约局");

    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") throw new Error("该球局已不在招募中，无法加入");
    if ((match.headcountJoined ?? 0) >= (match.headcountTarget || 2)) {
      throw new Error("该球局已满员");
    }

    const participants = match.participants || [];
    if (participants.some((p) => p.openid === openid)) {
      joinResult = { code: "already_joined" };
      return;
    }

    const addedParticipant = {
      openid,
      nickname: user.nickname || "匿名用户",
      avatar: user.avatarUrl || "",
      score: user.score || 0,
      yuedouFrozen: YUEDOU_FROZEN,
      resultChoice: null,
      locationVerified: false,
      locationVerifiedAt: null
    };

    await transaction.update(matchRef, {
      data: {
        participants: _.push(addedParticipant),
        headcountJoined: _.inc(1)
      }
    });

    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
    venueId = match.venueId || null;
  });

  // 记录球房访问失败不影响加入成功的资金事务。
  if (joinResult.code === "ok" && venueId) {
    try { await recordVenueAccess(openid, venueId, matchId); } catch (_) {}
  }

  return joinResult;
}

// ── 退出球局 ───────────────────────────────────────────────
async function doLeave(openid, matchId) {
  let leaveResult = { code: "left" };

  await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");

    const participants = match.participants || [];
    const me = getParticipantByOpenid(participants, openid);
    if (!me) throw new Error("你不在此球局中，无法退出");

    if (match.status !== "recruiting") {
      throw new Error("比赛已开始或已结束，不能退出");
    }

    if (match.hostOpenid === openid) {
      await refundFrozenInTransaction(transaction, match);
      await transaction.update(matchRef, {
        data: {
          status: "cancelled",
          participants: clearParticipantFrozen(participants),
          closedAt: db.serverDate(),
          closedBy: openid
        }
      });
      leaveResult = { code: "canceled_by_host" };
      return;
    }

    const frozenAmount = Number(me.yuedouFrozen || 0);
    await transaction.update(matchRef, {
      data: {
        participants: _.pull({ openid }),
        headcountJoined: _.inc(-1)
      }
    });

    if (frozenAmount > 0) {
      const user = await getUserDocInTransaction(transaction, openid);
      await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
        data: {
          yuedou: _.inc(frozenAmount),
          yuedouFrozen: _.inc(-frozenAmount)
        }
      });
    }
  });

  if (leaveResult.code === "canceled_by_host") {
    await addNotice({
      type: "match_canceled",
      targetOpenid: openid,
      matchId,
      content: `你发起的球局因你退出已被系统撤销`
    });
  }
  return leaveResult;
}

// ── 确认比赛开始 ───────────────────────────────────────────
async function doConfirm(openid, matchId) {
  let confirmedMatch = null;
  await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");
    if (match.hostOpenid !== openid) throw new Error("仅发起人可确认");
    if (match.status !== "recruiting") throw new Error("当前状态不可确认");

    const participants = match.participants || [];
    if (participants.length < (match.headcountTarget || 2)) {
      throw new Error("人数未满，不能开始比赛");
    }
    const allVerified = participants.every((p) => p.locationVerified);
    if (!allVerified) throw new Error("双方需先完成位置校验后才能开始比赛");

    await transaction.update(matchRef, {
      data: { status: "playing", startedAt: db.serverDate() }
    });
    confirmedMatch = match;
  });

  for (const uid of getUniqueParticipantOpenids(confirmedMatch)) {
    const isHost = uid === confirmedMatch.hostOpenid;
    await recordMatchParticipation(uid, matchId, isHost);
  }

  return { code: "ok" };
}

// ── 提交结果选择 ───────────────────────────────────────────
async function doSubmitResult(openid, matchId, choice) {
  const validChoices = ["win", "lose"];
  if (!validChoices.includes(choice)) throw new Error("无效的选择");

  const result = await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "playing") throw new Error("当前状态不能选择结果");

    const participants = match.participants || [];
    if (participants.length !== 2) throw new Error("当前仅支持两人局结算");
    const pIdx = participants.findIndex((p) => p.openid === openid);
    if (pIdx < 0) throw new Error("你不在此球局中");

    const updated = participants.map((p) => {
      if (p.openid === openid) return { ...p, resultChoice: choice };
      return p;
    });

    const bothSelected = updated.every((p) => p.resultChoice != null);
    if (!bothSelected) {
      await transaction.update(matchRef, { data: { participants: updated } });
      return { code: "ok", bothSelected: false };
    }

    const host = getParticipantByOpenid(updated, match.hostOpenid);
    const joiner = updated.find((p) => p.openid !== match.hostOpenid);
    if (!host || !joiner) throw new Error("球局参与人数据异常");

    const isConsistent = (host.resultChoice === "win" && joiner.resultChoice === "lose") ||
                         (host.resultChoice === "lose" && joiner.resultChoice === "win");
    if (!isConsistent) {
      await transaction.update(matchRef, {
        data: {
          participants: updated.map((p) => ({ ...p, resultChoice: null })),
          conflictAt: db.serverDate()
        }
      });
      return { code: "conflict", bothSelected: false };
    }

    await applySettlementInTransaction(transaction, matchRef, matchId, match, updated);
    return {
      code: "ok",
      bothSelected: true,
      settledOpenids: getUniqueParticipantOpenids({ ...match, participants: updated })
    };
  });

  const settledOpenids = result.settledOpenids || [];
  for (const oid of settledOpenids) {
    try { await recordMatchComplete(oid); } catch (_) {}
  }
  delete result.settledOpenids;
  return result;
}

// ── 位置校验 ───────────────────────────────────────────────
async function doVerifyLocation(openid, matchId, userLat, userLon, maxDistanceKm) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.status !== "recruiting") throw new Error("当前状态无法校验位置");

  const me = (match.participants || []).find((p) => p.openid === openid);
  if (!me) throw new Error("你不在此球局中");

  if (me.locationVerified) {
    return { code: "already_verified", verified: true };
  }

  const venueLat = match.venueLatitude;
  const venueLon = match.venueLongitude;
  const maxDist  = maxDistanceKm || 0.5;

  if (venueLat == null || venueLon == null) {
    // 球局没有设置位置，跳过距离校验
    const updated = (match.participants || []).map((p) => {
      if (p.openid === openid) return { ...p, locationVerified: true, locationVerifiedAt: Date.now() };
      return p;
    });
    await db.collection("matches").doc(matchId).update({ data: { participants: updated } });
    return { code: "ok", verified: true, distance: null };
  }

  const dist = _calcDistance(userLat, userLon, venueLat, venueLon);
  if (dist > maxDist) {
    return { code: "too_far", verified: false, distance: dist };
  }

  const updated = (match.participants || []).map((p) => {
    if (p.openid === openid) return { ...p, locationVerified: true, locationVerifiedAt: Date.now() };
    return p;
  });
  await db.collection("matches").doc(matchId).update({ data: { participants: updated } });

  return { code: "ok", verified: true, distance: dist };
}

// ── 结算 ───────────────────────────────────────────────────
async function applySettlementInTransaction(transaction, matchRef, matchId, match, participants) {
  const venueId = match.venueId || null;
  const plan = buildSettlementPlan(match, participants);
  const winner = getParticipantByOpenid(participants, plan.winnerId);
  const loser = getParticipantByOpenid(participants, plan.loserId);

  const winnerUser = await getUserDocInTransaction(transaction, plan.winnerId);
  const loserUser = await getUserDocInTransaction(transaction, plan.loserId);

  await transaction.update(db.collection("yueqiu8_users").doc(winnerUser._id), {
    data: {
      yuedou: _.inc(plan.winnerYuedouInc),
      yuedouFrozen: _.inc(plan.winnerFrozenInc)
    }
  });
  await transaction.update(db.collection("yueqiu8_users").doc(loserUser._id), {
    data: {
      yuedouFrozen: _.inc(plan.loserFrozenInc),
      yuedouSystem: _.inc(plan.loserSystemInc)
    }
  });

  await transaction.update(matchRef, {
    data: {
      status: "settled",
      participants: clearParticipantFrozen(participants),
      finalParticipants: participants.map((p) => ({
        openid: p.openid,
        nickname: p.nickname,
        resultChoice: p.resultChoice
      }))
    }
  });

  await transaction.add(db.collection("score_records"), {
    data: { userId: plan.winnerId, type: "match_win", amount: 10, venueId, matchId, createdAt: db.serverDate() }
  });
  await transaction.add(db.collection("score_records"), {
    data: { userId: plan.loserId, type: "match_lose", amount: 0, venueId, matchId, createdAt: db.serverDate() }
  });

  const winnerNick = (winner && winner.nickname) || "某用户";
  const loserNick = (loser && loser.nickname) || "某用户";
  await transaction.add(db.collection("notices"), {
    data: {
      type: "match_settled",
      targetOpenid: plan.winnerId,
      matchId,
      content: `🏆 你赢了「${loserNick}」！返还冻结约豆并获得 ${YUEDOU_WINNER} 约豆`,
      isRead: false,
      createdAt: db.serverDate()
    }
  });
  await transaction.add(db.collection("notices"), {
    data: {
      type: "match_settled",
      targetOpenid: plan.loserId,
      matchId,
      content: `😅 你输了「${winnerNick}」，本场冻结约豆已扣除`,
      isRead: false,
      createdAt: db.serverDate()
    }
  });
}

// ── 关闭/取消球局并退款 ───────────────────────────────────────
async function doClose(openid, matchId) {
  let closedStatus = "";
  await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可关闭");

    const isHost = match.hostOpenid === openid;
    const isParticipant = (match.participants || []).some((p) => p.openid === openid);
    if (!isHost && !isParticipant) throw new Error("你无权关闭此球局");

    if (match.status === "recruiting" && !isHost) {
      const expired = match.startAt && match.startAt < Date.now();
      if (!expired) throw new Error("仅发起人可关闭招募中的球局");
    }
    if (match.status === "playing" && !canForceClosePlaying(match, Date.now())) {
      throw new Error("比赛开始未满6小时，不能关闭");
    }

    await refundFrozenInTransaction(transaction, match);
    await transaction.update(matchRef, {
      data: {
        status: "cancelled",
        participants: clearParticipantFrozen(match.participants || []),
        closedAt: db.serverDate(),
        closedBy: openid
      }
    });
    closedStatus = match.status;
  });

  return { code: "closed", closedFrom: closedStatus };
}

async function doCancelByVenueOwner(openid, matchId) {
  await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可取消");

    const venueSnap = await transaction.get(db.collection("venues").doc(match.venueId));
    const venue = venueSnap.data;
    if (!venue || venue.ownerOpenid !== openid) throw new Error("你无权取消该球局");
    if (match.status === "playing" && !canForceClosePlaying(match, Date.now())) {
      throw new Error("比赛开始未满6小时，不能取消");
    }

    await refundFrozenInTransaction(transaction, match);
    await transaction.update(matchRef, {
      data: {
        status: "cancelled",
        participants: clearParticipantFrozen(match.participants || []),
        closedAt: db.serverDate(),
        closedBy: openid,
        closedByRole: "venue_owner"
      }
    });
  });

  return { code: "cancelled" };
}

// ── 主入口 ─────────────────────────────────────────────────
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, errMsg: "无法获取用户身份" };
  }

  const { action, matchId, matchData, choice, userLat, userLon, maxDistanceKm } = event;

  try {
    switch (action) {
      case "publish":
        return { ok: true, ...(await doPublish(OPENID, matchData || {})) };
      case "join":
        return { ok: true, ...(await doJoin(OPENID, matchId)) };
      case "leave":
        return { ok: true, ...(await doLeave(OPENID, matchId)) };
      case "confirm":
        return { ok: true, ...(await doConfirm(OPENID, matchId)) };
      case "submitResult":
        return { ok: true, ...(await doSubmitResult(OPENID, matchId, choice)) };
      case "verifyLocation":
        return await doVerifyLocation(OPENID, matchId, userLat, userLon, maxDistanceKm);
      case "close":
        return { ok: true, ...(await doClose(OPENID, matchId)) };
      case "cancelByVenueOwner":
        return { ok: true, ...(await doCancelByVenueOwner(OPENID, matchId)) };
      default:
        return { ok: false, errMsg: "未知操作: " + action };
    }
  } catch (e) {
    console.error(`matchService[${action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};

exports.__test = {
  buildFrozenRefunds,
  clearParticipantFrozen,
  getUniqueParticipantOpenids,
  buildSettlementPlan,
  canForceClosePlaying,
  PLAYING_CLOSE_AFTER_MS
};
