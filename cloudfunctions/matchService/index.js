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

// 积分常量
const SCORE_CREATE_MATCH  = 5;
const SCORE_JOIN_MATCH    = 3;
const SCORE_COMPLETE_MATCH = 2;

// 辅助函数：服务端获取用户数据（云函数内用 openid 查库）
async function getUserByOpenid(openid, transaction) {
  const query = db.collection("yueqiu8_users").where({ openid });
  const res = transaction ? await transaction.get(query) : await query.get();
  return res.data[0] || null;
}

function uniqueOpenids(openids) {
  return Array.from(new Set((openids || []).filter(Boolean)));
}

function getParticipantFrozen(participant) {
  if (!participant) return 0;
  // 旧数据可能没有 yuedouFrozen 字段；活跃球局按一场 500 约豆处理，避免取消时锁死余额。
  return participant.yuedouFrozen == null ? YUEDOU_FROZEN : participant.yuedouFrozen;
}

function getTimeMs(value) {
  if (!value) return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value.toDate === "function") return value.toDate().getTime();
  return null;
}

async function refundParticipantsInTransaction(transaction, participants) {
  const frozenByOpenid = {};
  (participants || []).forEach((p) => {
    if (!p || !p.openid) return;
    frozenByOpenid[p.openid] = (frozenByOpenid[p.openid] || 0) + getParticipantFrozen(p);
  });

  for (const uid of Object.keys(frozenByOpenid)) {
    const amount = frozenByOpenid[uid];
    if (amount <= 0) continue;
    const user = await getUserByOpenid(uid, transaction);
    if (!user) throw new Error("用户不存在，无法退还冻结约豆");
    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: {
        yuedou: _.inc(amount),
        yuedouFrozen: _.inc(-amount)
      }
    });
  }
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

// ── 发布球局 ───────────────────────────────────────────────
async function doPublish(openid, matchData) {
  const headcountTarget = matchData.headcountTarget || 2;
  if (headcountTarget !== 2) throw new Error("当前只支持2人对战");
  if (!matchData.startAt) throw new Error("请选择开局时间");
  if (!matchData.venueId) throw new Error("请选择球房");

  let matchId = null;
  await db.runTransaction(async (transaction) => {
    const user = await getUserByOpenid(openid, transaction);
    if (!user) throw new Error("用户不存在，请先登录");

    const activeRes = await transaction.get(db.collection("matches").where(
      _.or(
        { hostOpenid: openid },
        { participants: _.elemMatch({ openid }) }
      )
    ));
    const activeMatch = (activeRes.data || []).find((m) => ["recruiting", "playing"].includes(m.status));
    if (activeMatch) throw new Error("你已有进行中的球局，请先结束后再发起");

    const yuedou = user.yuedou ?? 0;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法发起约局");

    const nickname = user.nickname || "匿名用户";
    const avatar = user.avatarUrl || "";
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

  if (matchData.venueId && matchId) {
    try { await recordVenueAccess(openid, matchData.venueId, matchId); } catch (e) {
      console.error("记录球房访问失败", e);
    }
  }

  return { code: "ok" };
}

// ── 加入球局 ───────────────────────────────────────────────
async function doJoin(openid, matchId) {
  let outcome = { code: "ok" };
  let venueId = null;

  await db.runTransaction(async (transaction) => {
    const user = await getUserByOpenid(openid, transaction);
    if (!user) throw new Error("用户不存在，请先登录");
    const yuedou = user.yuedou ?? 0;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法加入约局");

    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") throw new Error("该球局已不在招募中，无法加入");

    const participants = match.participants || [];
    if (participants.some((p) => p.openid === openid)) {
      outcome = { code: "already_joined" };
      return;
    }

    const headcountTarget = match.headcountTarget || 2;
    if (headcountTarget !== 2) throw new Error("当前只支持2人对战");
    if (participants.length >= headcountTarget || (match.headcountJoined ?? participants.length) >= headcountTarget) {
      throw new Error("该球局已满员");
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
    const updatedParticipants = participants.concat(addedParticipant);
    venueId = match.venueId || null;

    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        participants: updatedParticipants,
        headcountJoined: updatedParticipants.length
      }
    });

    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  });

  if (outcome.code === "ok" && venueId) {
    try { await recordVenueAccess(openid, venueId, matchId); } catch (e) {
      console.error("记录球房访问失败", e);
    }
  }

  return outcome;
}

// ── 退出球局 ───────────────────────────────────────────────
async function doLeave(openid, matchId) {
  let outcome = { code: "left" };
  let noticeTargets = [];

  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") {
      throw new Error("比赛已开始或已结束，不能退出");
    }

    const participants = match.participants || [];
    const me = participants.find((p) => p.openid === openid);
    if (!me) throw new Error("你不在此球局中，无法退出");

    if (match.hostOpenid === openid) {
      await refundParticipantsInTransaction(transaction, participants);
      await transaction.update(db.collection("matches").doc(matchId), {
        data: {
          status: "cancelled",
          closedAt: db.serverDate(),
          closedBy: openid
        }
      });
      noticeTargets = uniqueOpenids(participants.map((p) => p.openid));
      outcome = { code: "canceled_by_host" };
      return;
    }

    const frozenAmount = getParticipantFrozen(me);
    if (frozenAmount > 0) {
      const user = await getUserByOpenid(openid, transaction);
      if (!user) throw new Error("用户不存在，无法退还冻结约豆");
      await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
        data: {
          yuedou: _.inc(frozenAmount),
          yuedouFrozen: _.inc(-frozenAmount)
        }
      });
    }

    const updatedParticipants = participants.filter((p) => p.openid !== openid);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        participants: updatedParticipants,
        headcountJoined: updatedParticipants.length
      }
    });
  });

  for (const uid of noticeTargets) {
    try {
      await addNotice({
        type: "match_canceled",
        targetOpenid: uid,
        matchId,
        content: `球局已被发起人撤销，冻结约豆已退还`
      });
    } catch (e) {
      console.error("撤销通知发送失败", e);
    }
  }

  return outcome;
}

// ── 确认比赛开始 ───────────────────────────────────────────
async function doConfirm(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.hostOpenid !== openid) throw new Error("仅发起人可确认");
  if (match.status !== "recruiting") throw new Error("当前状态不可确认");

  const participants = match.participants || [];
  const expectedCount = match.headcountTarget || 2;
  if (expectedCount !== 2 || participants.length !== 2 || (match.headcountJoined ?? participants.length) !== 2) {
    throw new Error("当前只支持2人满员后开始比赛");
  }
  const participantOpenids = uniqueOpenids(participants.map((p) => p.openid));
  if (participantOpenids.length !== 2 || !participantOpenids.includes(match.hostOpenid)) {
    throw new Error("参与者数据异常，无法开始比赛");
  }

  const allVerified = participants.every((p) => p.locationVerified);
  if (!allVerified) throw new Error("双方需先完成位置校验后才能开始比赛");

  await db.collection("matches").doc(matchId).update({
    data: { status: "playing", startedAt: db.serverDate() }
  });

  for (const uid of participantOpenids) {
    const isHost = uid === match.hostOpenid;
    await recordMatchParticipation(uid, matchId, isHost);
  }

  return { code: "ok" };
}

// ── 提交结果选择 ───────────────────────────────────────────
async function doSubmitResult(openid, matchId, choice) {
  const validChoices = ["win", "lose"];
  if (!validChoices.includes(choice)) throw new Error("无效的选择");

  let outcome = { code: "ok", bothSelected: false };
  let settledNotice = null;

  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "playing") throw new Error("当前状态不能选择结果");

    const participants = match.participants || [];
    if (participants.length !== 2) throw new Error("参与者数据异常，无法结算");
    const pIdx = participants.findIndex((p) => p.openid === openid);
    if (pIdx < 0) throw new Error("你不在此球局中");

    const updated = participants.map((p) => {
      if (p.openid === openid) return { ...p, resultChoice: choice };
      return p;
    });

    const bothSelected = updated.every((p) => p.resultChoice != null);
    if (!bothSelected) {
      await transaction.update(db.collection("matches").doc(matchId), {
        data: { participants: updated }
      });
      outcome = { code: "ok", bothSelected: false };
      return;
    }

    const choices = {};
    updated.forEach((p) => { choices[p.openid] = p.resultChoice; });
    const hostChoice = choices[match.hostOpenid] || "";
    const joiner = updated.find((p) => p.openid !== match.hostOpenid);
    if (!joiner) throw new Error("参与者数据异常，无法结算");
    const joinChoice = choices[joiner.openid] || "";
    const isConsistent = (hostChoice === "win" && joinChoice === "lose") ||
                         (hostChoice === "lose" && joinChoice === "win");

    if (!isConsistent) {
      await transaction.update(db.collection("matches").doc(matchId), {
        data: {
          participants: updated.map((p) => ({ ...p, resultChoice: null })),
          conflictAt: db.serverDate()
        }
      });
      outcome = { code: "conflict", bothSelected: false };
      return;
    }

    const winnerId = hostChoice === "win" ? match.hostOpenid : joiner.openid;
    const loserId = winnerId === match.hostOpenid ? joiner.openid : match.hostOpenid;
    const winner = updated.find((p) => p.openid === winnerId);
    const loser = updated.find((p) => p.openid === loserId);
    const winnerFrozen = getParticipantFrozen(winner);
    const loserFrozen = getParticipantFrozen(loser);
    const winnerUser = await getUserByOpenid(winnerId, transaction);
    const loserUser = await getUserByOpenid(loserId, transaction);
    if (!winnerUser || !loserUser) throw new Error("用户数据异常，无法结算");

    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "settled",
        participants: updated.map((p) => ({ ...p, yuedouFrozen: 0 })),
        finalParticipants: updated.map((p) => ({
          openid: p.openid,
          nickname: p.nickname,
          resultChoice: p.resultChoice
        }))
      }
    });

    await transaction.update(db.collection("yueqiu8_users").doc(winnerUser._id), {
      data: {
        yuedou: _.inc(winnerFrozen + YUEDOU_WINNER),
        yuedouFrozen: _.inc(-winnerFrozen)
      }
    });
    await transaction.update(db.collection("yueqiu8_users").doc(loserUser._id), {
      data: {
        yuedouFrozen: _.inc(-loserFrozen),
        yuedouSystem: _.inc(YUEDOU_SYSTEM)
      }
    });

    await transaction.add(db.collection("score_records"), {
      data: {
        userId: winnerId,
        type: "match_win",
        amount: YUEDOU_WINNER,
        venueId: match.venueId || null,
        matchId,
        createdAt: db.serverDate()
      }
    });
    await transaction.add(db.collection("score_records"), {
      data: {
        userId: loserId,
        type: "match_lose",
        amount: 0,
        venueId: match.venueId || null,
        matchId,
        createdAt: db.serverDate()
      }
    });

    settledNotice = {
      winnerId,
      loserId,
      winnerNick: winner?.nickname || "某用户",
      loserNick: loser?.nickname || "某用户",
      participants: updated
    };
    outcome = { code: "ok", bothSelected: true };
  });

  if (settledNotice) {
    try {
      await addNotice({
        type: "match_settled",
        targetOpenid: settledNotice.winnerId,
        matchId,
        content: `🏆 你赢了「${settledNotice.loserNick}」！获得+${YUEDOU_WINNER}约豆，冻结约豆已退回`
      });
      await addNotice({
        type: "match_settled",
        targetOpenid: settledNotice.loserId,
        matchId,
        content: `😅 你输了「${settledNotice.winnerNick}」，本场冻结约豆已结算`
      });
    } catch (e) {
      console.error("结算通知发送失败", e);
    }

    for (const uid of uniqueOpenids(settledNotice.participants.map((p) => p.openid))) {
      try { await recordMatchComplete(uid); } catch (_) {}
    }
  }

  return outcome;
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
async function doSettleMatch(matchId, match, participants) {
  throw new Error("结算必须通过 doSubmitResult 的事务路径执行");
}

// ── 关闭异常/过期球局 ───────────────────────────────────────
async function doClose(openid, matchId) {
  let matchSnapshot = null;
  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可关闭");

    const participants = match.participants || [];
    const isHost = match.hostOpenid === openid;
    const isParticipant = participants.some((p) => p.openid === openid);
    if (!isHost && !isParticipant) throw new Error("你无权关闭此球局");

    if (match.status === "recruiting") {
      if (!isHost) throw new Error("仅发起人可关闭招募中的球局");
    } else {
      const startedAt = getTimeMs(match.startedAt);
      if (!startedAt || Date.now() - startedAt < 6 * 60 * 60 * 1000) {
        throw new Error("比赛开始未超过6小时，不能强制关闭");
      }
    }

    await refundParticipantsInTransaction(transaction, participants);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "cancelled",
        closedAt: db.serverDate(),
        closedBy: openid
      }
    });
    matchSnapshot = match;
  });

  if (matchSnapshot) {
    const noticeType = matchSnapshot.status === "recruiting" ? "match_canceled" : "match_closed";
    for (const uid of uniqueOpenids((matchSnapshot.participants || []).map((p) => p.openid))) {
      try {
        await addNotice({
          type: noticeType,
          targetOpenid: uid,
          matchId,
          content: matchSnapshot.status === "recruiting"
            ? `「${matchSnapshot.venueName || "球局"}」已关闭，冻结约豆已退还`
            : `「${matchSnapshot.venueName || "球局"}」因超时被关闭，冻结约豆已退还`
        });
      } catch (e) {
        console.error("关闭通知发送失败", e);
      }
    }
  }

  return { code: "closed" };
}

// ── 商家取消本店球局 ───────────────────────────────────────
async function doCancelByVenueOwner(openid, matchId) {
  let matchSnapshot = null;
  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可取消");
    if (!match.venueId) throw new Error("球局缺少球房信息");

    const venueRes = await transaction.get(db.collection("venues").doc(match.venueId));
    const venue = venueRes.data;
    if (!venue || venue.ownerOpenid !== openid) throw new Error("仅球房商家可取消本店球局");

    await refundParticipantsInTransaction(transaction, match.participants || []);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "cancelled",
        closedAt: db.serverDate(),
        closedBy: openid,
        closedByRole: "venue_owner"
      }
    });
    matchSnapshot = match;
  });

  if (matchSnapshot) {
    for (const uid of uniqueOpenids((matchSnapshot.participants || []).map((p) => p.openid))) {
      try {
        await addNotice({
          type: "match_canceled",
          targetOpenid: uid,
          matchId,
          content: `球房商家已取消「${matchSnapshot.venueName || "球局"}」，冻结约豆已退还`
        });
      } catch (e) {
        console.error("商家取消通知发送失败", e);
      }
    }
  }

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
      case "close":
        return { ok: true, ...(await doClose(OPENID, matchId)) };
      case "cancelByVenueOwner":
        return { ok: true, ...(await doCancelByVenueOwner(OPENID, matchId)) };
      case "confirm":
        return { ok: true, ...(await doConfirm(OPENID, matchId)) };
      case "submitResult":
        return { ok: true, ...(await doSubmitResult(OPENID, matchId, choice)) };
      case "verifyLocation":
        return await doVerifyLocation(OPENID, matchId, userLat, userLon, maxDistanceKm);
      default:
        return { ok: false, errMsg: "未知操作: " + action };
    }
  } catch (e) {
    console.error(`matchService[${action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
