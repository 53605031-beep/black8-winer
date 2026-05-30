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
 *   close            关闭异常/过期球局并退回本局冻结约豆
 *   cancelByVenueOwner 商家取消本店球局并退回本局冻结约豆
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 约豆常量（与 utils/cloudDB.js 保持一致）
const YUEDOU_INITIAL = 10000;
const YUEDOU_FROZEN  = 500;
const YUEDOU_WINNER  = 420;   // 赢家获得
const YUEDOU_LOSER   = 500;    // 输家实际损失，已在开局前冻结
const YUEDOU_SYSTEM  = 80;     // 系统抽成

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

// 在事务里退回某场球局冻结的约豆，只按 participants 里记录的本局冻结额处理。
async function refundFrozenInTransaction(transaction, participants) {
  const refunded = new Set();
  for (const p of participants || []) {
    if (!p || !p.openid || refunded.has(p.openid)) continue;
    const frozen = p.yuedouFrozen ?? 0;
    if (frozen <= 0) continue;
    refunded.add(p.openid);
    await transaction.update(db.collection("yueqiu8_users").where({ openid: p.openid }), {
      data: {
        yuedou: _.inc(frozen),
        yuedouFrozen: _.inc(-frozen)
      }
    });
  }
}

function clearParticipantFrozen(participants) {
  return (participants || []).map((p) => ({ ...p, yuedouFrozen: 0 }));
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
  if (headcountTarget < 2) throw new Error("每局至少需要2人");
  if (!matchData.startAt) throw new Error("请选择开局时间");
  if (!matchData.venueId) throw new Error("请选择球房");

  let matchId = "";

  await db.runTransaction(async (transaction) => {
    const userRecord = await transaction.get(db.collection("yueqiu8_users").where({ openid }).limit(1));
    const user = userRecord.data && userRecord.data[0];
    if (!user) throw new Error("用户不存在，请先登录");
    const yuedou = user.yuedou ?? YUEDOU_INITIAL;
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

    await transaction.update(db.collection("yueqiu8_users").where({ openid }), {
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  });

  if (matchData.venueId) {
    try {
      await recordVenueAccess(openid, matchData.venueId, matchId);
    } catch (e) {
      console.error("记录球房访问失败（不影响发布）", e);
    }
  }

  return { code: "ok", matchId };
}

// ── 加入球局 ───────────────────────────────────────────────
async function doJoin(openid, matchId) {
  let code = "ok";
  let venueId = null;

  await db.runTransaction(async (transaction) => {
    const userRecord = await transaction.get(db.collection("yueqiu8_users").where({ openid }).limit(1));
    const user = userRecord.data && userRecord.data[0];
    if (!user) throw new Error("用户不存在，请先登录");
    const yuedou = user.yuedou ?? YUEDOU_INITIAL;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法加入约局");

    const matchRecord = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") throw new Error("该球局已不在招募中，无法加入");

    const participants = match.participants || [];
    if (participants.some((p) => p.openid === openid)) {
      code = "already_joined";
      venueId = match.venueId || null;
      return;
    }

    const headcountTarget = match.headcountTarget || 2;
    if (participants.length >= headcountTarget || (match.headcountJoined ?? 0) >= headcountTarget) {
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

    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        participants: _.push(addedParticipant),
        headcountJoined: _.inc(1)
      }
    });
    await transaction.update(db.collection("yueqiu8_users").where({ openid }), {
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
    venueId = match.venueId || null;
  });

  if (venueId) {
    try {
      await recordVenueAccess(openid, venueId, matchId);
    } catch (e) {
      console.error("记录球房访问失败（不影响加入）", e);
    }
  }

  return { code };
}

// ── 退出球局 ───────────────────────────────────────────────
async function doLeave(openid, matchId) {
  let resultCode = "left";
  let hostOpenid = "";
  let venueName = "";

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") {
      throw new Error("比赛已开始或已结束，不能退出");
    }

    const participants = match.participants || [];
    const me = participants.find((p) => p.openid === openid);
    if (!me) throw new Error("你不在此球局中，无法退出");

    hostOpenid = match.hostOpenid;
    venueName = match.venueName || "球局";

    if (match.hostOpenid === openid) {
      await refundFrozenInTransaction(transaction, participants);
      await transaction.update(db.collection("matches").doc(matchId), {
        data: {
          status: "cancelled",
          cancelledAt: db.serverDate(),
          cancelledBy: openid,
          participants: clearParticipantFrozen(participants)
        }
      });
      resultCode = "canceled_by_host";
      return;
    }

    const frozenAmount = me.yuedouFrozen ?? 0;
    if (frozenAmount > 0) {
      await transaction.update(db.collection("yueqiu8_users").where({ openid }), {
        data: {
          yuedou: _.inc(frozenAmount),
          yuedouFrozen: _.inc(-frozenAmount)
        }
      });
    }

    const remaining = participants.filter((p) => p.openid !== openid);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        participants: remaining,
        headcountJoined: remaining.length
      }
    });
  });

  if (resultCode === "canceled_by_host") {
    await addNotice({
      type: "match_canceled",
      targetOpenid: hostOpenid,
      matchId,
      content: `你发起的「${venueName}」球局因你退出已撤销，冻结约豆已退还`
    });
  }

  return { code: resultCode };
}

// ── 确认比赛开始 ───────────────────────────────────────────
async function doConfirm(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.hostOpenid !== openid) throw new Error("仅发起人可确认");
  if (match.status !== "recruiting") throw new Error("当前状态不可确认");

  const allVerified = (match.participants || []).every((p) => p.locationVerified);
  if (!allVerified) throw new Error("双方需先完成位置校验后才能开始比赛");
  if ((match.participants || []).length < (match.headcountTarget || 2)) {
    throw new Error("球局尚未满员，不能开始比赛");
  }

  await db.collection("matches").doc(matchId).update({
    data: { status: "playing", startedAt: db.serverDate() }
  });

  const allOpenids = Array.from(new Set([match.hostOpenid, ...(match.participants || []).map((p) => p.openid)]));
  for (const uid of allOpenids) {
    const isHost = uid === match.hostOpenid;
    await recordMatchParticipation(uid, matchId, isHost);
  }

  return { code: "ok" };
}

// ── 提交结果选择 ───────────────────────────────────────────
async function doSubmitResult(openid, matchId, choice) {
  const validChoices = ["win", "lose"];
  if (!validChoices.includes(choice)) throw new Error("无效的选择");

  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.status !== "playing") throw new Error("当前状态不能选择结果");

  const pIdx = (match.participants || []).findIndex((p) => p.openid === openid);
  if (pIdx < 0) throw new Error("你不在此球局中");

  const updated = (match.participants || []).map((p) => {
    if (p.openid === openid) return { ...p, resultChoice: choice };
    return p;
  });

  await db.collection("matches").doc(matchId).update({
    data: { participants: updated }
  });

  const bothSelected = updated.every((p) => p.resultChoice != null);
  if (bothSelected) {
    const choices = updated.map((p) => p.resultChoice);
    const hostChoice  = choices[0];
    const joinChoice = choices[1];
    // 赢+输 才结算，其他情况（一样或冲突）都重置
    const isConsistent = (hostChoice === "win" && joinChoice === "lose") ||
                         (hostChoice === "lose" && joinChoice === "win");
    if (isConsistent) {
      await doSettleMatch(matchId, match, updated);
      return { code: "ok", bothSelected: true };
    } else {
      await db.collection("matches").doc(matchId).update({
        data: {
          participants: updated.map((p) => ({ ...p, resultChoice: null })),
          conflictAt: db.serverDate()
        }
      });
      return { code: "conflict", bothSelected: false };
    }
  }

  return { code: "ok", bothSelected: false };
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
  let winnerId = null;
  let loserId = null;
  let venueId = match.venueId || null;
  let finalParticipants = [];

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.get(db.collection("matches").doc(matchId));
    const currentMatch = matchRecord.data;
    if (!currentMatch) throw new Error("球局不存在");
    if (currentMatch.status !== "playing") throw new Error("当前状态不能结算");

    const currentParticipants = currentMatch.participants || participants || [];
    const choices = {};
    currentParticipants.forEach((p) => { choices[p.openid] = p.resultChoice; });

    const openids = currentParticipants.map((p) => p.openid);
    const joinOpenid = openids.find((o) => o !== currentMatch.hostOpenid);
    const hostChoice = choices[currentMatch.hostOpenid] || "";
    const joinChoice = choices[joinOpenid] || "";
    venueId = currentMatch.venueId || null;

    if (hostChoice === "win" && joinChoice === "lose") {
      winnerId = currentMatch.hostOpenid;
      loserId = joinOpenid;
    } else if (hostChoice === "lose" && joinChoice === "win") {
      winnerId = joinOpenid;
      loserId = currentMatch.hostOpenid;
    } else {
      throw new Error("双方结果不一致，无法结算");
    }

    const winner = currentParticipants.find((p) => p.openid === winnerId);
    const loser = currentParticipants.find((p) => p.openid === loserId);
    const winnerFrozen = winner?.yuedouFrozen ?? YUEDOU_FROZEN;
    const loserFrozen = loser?.yuedouFrozen ?? YUEDOU_FROZEN;

    // 冻结约豆已经在发布/加入时从可用余额扣除，结算时只释放本局冻结额。
    await transaction.update(db.collection("yueqiu8_users").where({ openid: winnerId }), {
      data: {
        yuedou: _.inc(winnerFrozen + YUEDOU_WINNER),
        yuedouFrozen: _.inc(-winnerFrozen),
        yuedouSystem: _.inc(YUEDOU_SYSTEM)
      }
    });
    await transaction.update(db.collection("yueqiu8_users").where({ openid: loserId }), {
      data: {
        yuedou: _.inc(Math.max(0, loserFrozen - YUEDOU_LOSER)),
        yuedouFrozen: _.inc(-loserFrozen),
        yuedouSystem: _.inc(YUEDOU_SYSTEM)
      }
    });

    finalParticipants = currentParticipants.map((p) => ({
      openid: p.openid,
      nickname: p.nickname,
      resultChoice: p.resultChoice
    }));

    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "settled",
        participants: clearParticipantFrozen(currentParticipants),
        finalParticipants
      }
    });
  });

  await addScoreRecord(winnerId, "match_win", 10, venueId, matchId);
  await addScoreRecord(loserId, "match_lose", 0, venueId, matchId);

  const winnerNick = finalParticipants.find((p) => p.openid === winnerId)?.nickname || "某用户";
  const loserNick = finalParticipants.find((p) => p.openid === loserId)?.nickname || "某用户";
  await addNotice({ type: "match_settled", targetOpenid: winnerId, matchId, content: `🏆 你赢了「${loserNick}」！获得约豆，冻结约豆已解冻` });
  await addNotice({ type: "match_settled", targetOpenid: loserId, matchId, content: `😅 你输了「${winnerNick}」，本局冻结约豆已扣除` });

  for (const oid of Array.from(new Set(finalParticipants.map((p) => p.openid)))) {
    try { await recordMatchComplete(oid); } catch (_) {}
  }
}

// ── 关闭异常/过期球局 ───────────────────────────────────────
async function doClose(openid, matchId) {
  let targetOpenids = [];
  let venueName = "球局";

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可关闭");

    const participants = match.participants || [];
    const isHost = match.hostOpenid === openid;
    const isParticipant = participants.some((p) => p.openid === openid);
    if (!isHost && !isParticipant) throw new Error("你无权关闭此球局");
    if (match.status === "recruiting" && !isHost) throw new Error("仅发起人可关闭招募中的球局");

    await refundFrozenInTransaction(transaction, participants);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "cancelled",
        closedAt: db.serverDate(),
        closedBy: openid,
        participants: clearParticipantFrozen(participants)
      }
    });

    venueName = match.venueName || venueName;
    targetOpenids = Array.from(new Set(participants.map((p) => p.openid).filter(Boolean)));
  });

  for (const targetOpenid of targetOpenids) {
    await addNotice({
      type: "match_closed",
      targetOpenid,
      matchId,
      content: `「${venueName}」球局已关闭，本局冻结约豆已退还`
    });
  }

  return { code: "closed" };
}

// ── 商家取消本店球局 ────────────────────────────────────────
async function doCancelByVenueOwner(openid, matchId) {
  let targetOpenids = [];
  let venueName = "球局";

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可取消");
    if (!match.venueId) throw new Error("球局缺少球房信息");

    const venueRecord = await transaction.get(db.collection("venues").doc(match.venueId));
    const venue = venueRecord.data;
    if (!venue || venue.ownerOpenid !== openid) throw new Error("只有该球房商家可取消");

    const participants = match.participants || [];
    await refundFrozenInTransaction(transaction, participants);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "cancelled",
        cancelledAt: db.serverDate(),
        cancelledBy: openid,
        cancelledByRole: "venue_owner",
        participants: clearParticipantFrozen(participants)
      }
    });

    venueName = match.venueName || venue.name || venueName;
    targetOpenids = Array.from(new Set(participants.map((p) => p.openid).filter(Boolean)));
  });

  for (const targetOpenid of targetOpenids) {
    await addNotice({
      type: "match_canceled",
      targetOpenid,
      matchId,
      content: `「${venueName}」球局已由商家取消，本局冻结约豆已退还`
    });
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
