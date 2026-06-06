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

function positiveAmount(value, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : fallback;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  return new Date(value).getTime() || 0;
}

function dedupeParticipants(participants = []) {
  const seen = new Set();
  const result = [];
  for (const p of participants) {
    if (!p || !p.openid || seen.has(p.openid)) continue;
    seen.add(p.openid);
    result.push(p);
  }
  return result;
}

function uniqueOpenids(openids = []) {
  return Array.from(new Set(openids.filter(Boolean)));
}

function getFrozenAmount(participant) {
  return positiveAmount(participant?.yuedouFrozen, YUEDOU_FROZEN);
}

async function getRequiredUser(openid) {
  const user = await getUserByOpenid(openid);
  if (!user) throw new Error("用户不存在，请先登录");
  return user;
}

async function getUserMap(openids) {
  const map = {};
  for (const openid of uniqueOpenids(openids)) {
    map[openid] = await getRequiredUser(openid);
  }
  return map;
}

async function getUserInTransaction(transaction, userDoc) {
  const res = await transaction.collection("yueqiu8_users").doc(userDoc._id).get();
  const user = res.data;
  if (!user) throw new Error("用户不存在，请先登录");
  return user;
}

async function updateUserByOpenid(transaction, userMap, openid, data) {
  const userDoc = userMap[openid];
  if (!userDoc) throw new Error("用户不存在，请先登录");
  await transaction.collection("yueqiu8_users").doc(userDoc._id).update({ data });
}

async function refundFrozenInTransaction(transaction, userMap, participants) {
  const unique = dedupeParticipants(participants);
  for (const p of unique) {
    const frozen = positiveAmount(p.yuedouFrozen, 0);
    if (frozen <= 0) continue;
    await updateUserByOpenid(transaction, userMap, p.openid, {
      yuedou: _.inc(frozen),
      yuedouFrozen: _.inc(-frozen)
    });
  }
  return unique.map((p) => ({ ...p, yuedouFrozen: 0 }));
}

function buildSettlement(match, participants) {
  const unique = dedupeParticipants(participants);
  if (unique.length !== (match.headcountTarget || 2)) {
    throw new Error("参与人数不足，不能结算");
  }

  const host = unique.find((p) => p.openid === match.hostOpenid);
  const opponent = unique.find((p) => p.openid !== match.hostOpenid);
  if (!host || !opponent) throw new Error("结算参与人异常");

  let winner = null;
  let loser = null;
  if (host.resultChoice === "win" && opponent.resultChoice === "lose") {
    winner = host;
    loser = opponent;
  } else if (host.resultChoice === "lose" && opponent.resultChoice === "win") {
    winner = opponent;
    loser = host;
  }

  return {
    unique,
    winner,
    loser,
    consistent: !!winner && !!loser,
    finalParticipants: unique.map((p) => ({
      openid: p.openid,
      nickname: p.nickname,
      resultChoice: p.resultChoice
    }))
  };
}

// ── 发布球局 ───────────────────────────────────────────────
async function doPublish(openid, matchData) {
  const headcountTarget = matchData.headcountTarget || 2;
  if (headcountTarget < 2) throw new Error("每局至少需要2人");
  if (!matchData.startAt) throw new Error("请选择开局时间");
  if (!matchData.venueId) throw new Error("请选择球房");

  let matchId = null;
  const userDoc = await getRequiredUser(openid);
  await db.runTransaction(async (transaction) => {
    const user = await getUserInTransaction(transaction, userDoc);
    const yuedou = user.yuedou ?? YUEDOU_INITIAL;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法发起约局");

    const nickname = user.nickname || "匿名用户";
    const matchRes = await transaction.collection("matches").add({
      data: {
        ...matchData,
        hostOpenid: openid,
        hostNickname: nickname,
        participants: [{
          openid,
          nickname,
          avatar: user.avatarUrl || "",
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

    await transaction.collection("yueqiu8_users").doc(userDoc._id).update({
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  });

  if (matchData.venueId && matchId) {
    await recordVenueAccess(openid, matchData.venueId, matchId);
  }

  return { code: "ok", matchId };
}

// ── 加入球局 ───────────────────────────────────────────────
async function doJoin(openid, matchId) {
  let result = { code: "ok" };
  let venueId = null;
  const userDoc = await getRequiredUser(openid);

  await db.runTransaction(async (transaction) => {
    const user = await getUserInTransaction(transaction, userDoc);
    const yuedou = user.yuedou ?? YUEDOU_INITIAL;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法加入约局");

    const matchRecord = await transaction.collection("matches").doc(matchId).get();
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") throw new Error("该球局已不在招募中，无法加入");

    const participants = dedupeParticipants(match.participants || []);
    if (participants.some((p) => p.openid === openid)) {
      result = { code: "already_joined" };
      return;
    }
    if (participants.length >= (match.headcountTarget || 2)) {
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

    await transaction.collection("matches").doc(matchId).update({
      data: {
        participants: updatedParticipants,
        headcountJoined: updatedParticipants.length
      }
    });
    await transaction.collection("yueqiu8_users").doc(userDoc._id).update({
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  });

  if (result.code === "ok" && venueId) {
    await recordVenueAccess(openid, venueId, matchId);
  }

  return result;
}

// ── 退出球局 ───────────────────────────────────────────────
async function doLeave(openid, matchId) {
  let result = { code: "left" };
  const preMatch = await getMatch(matchId);
  if (!preMatch) throw new Error("球局不存在");
  const userMap = await getUserMap(dedupeParticipants(preMatch.participants || []).map((p) => p.openid));

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.collection("matches").doc(matchId).get();
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");

    const participants = dedupeParticipants(match.participants || []);
    const me = participants.find((p) => p.openid === openid);
    if (!me) throw new Error("你不在此球局中，无法退出");

    if (match.status !== "recruiting") {
      throw new Error("比赛已开始或已结束，不能退出");
    }

    if (match.hostOpenid === openid) {
      const refundedParticipants = await refundFrozenInTransaction(transaction, userMap, participants);
      await transaction.collection("matches").doc(matchId).update({
        data: {
          status: "cancelled",
          participants: refundedParticipants,
          headcountJoined: refundedParticipants.length,
          closedAt: db.serverDate(),
          closedBy: openid
        }
      });
      result = { code: "canceled_by_host" };
      return;
    }

    const frozenAmount = positiveAmount(me.yuedouFrozen, 0);
    const updatedParticipants = participants.filter((p) => p.openid !== openid);
    await transaction.collection("matches").doc(matchId).update({
      data: {
        participants: updatedParticipants,
        headcountJoined: updatedParticipants.length
      }
    });

    if (frozenAmount > 0) {
      await updateUserByOpenid(transaction, userMap, openid, {
        yuedou: _.inc(frozenAmount),
        yuedouFrozen: _.inc(-frozenAmount)
      });
    }
  });

  if (result.code === "canceled_by_host") {
    await addNotice({
      type: "match_canceled",
      targetOpenid: openid,
      matchId,
      content: "你发起的球局因你退出已被系统撤销"
    });
  }

  return result;
}

// ── 确认比赛开始 ───────────────────────────────────────────
async function doConfirm(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.hostOpenid !== openid) throw new Error("仅发起人可确认");
  if (match.status !== "recruiting") throw new Error("当前状态不可确认");

  const participants = dedupeParticipants(match.participants || []);
  if (participants.length < (match.headcountTarget || 2)) {
    throw new Error("人数未满，不能开始比赛");
  }

  const allVerified = participants.every((p) => p.locationVerified);
  if (!allVerified) throw new Error("双方需先完成位置校验后才能开始比赛");

  await db.collection("matches").doc(matchId).update({
    data: { status: "playing", startedAt: db.serverDate() }
  });

  const allOpenids = uniqueOpenids([match.hostOpenid, ...participants.map((p) => p.openid)]);
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

  let result = { code: "ok", bothSelected: false };
  let noticePayloads = [];
  const preMatch = await getMatch(matchId);
  if (!preMatch) throw new Error("球局不存在");
  const userMap = await getUserMap(dedupeParticipants(preMatch.participants || []).map((p) => p.openid));

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.collection("matches").doc(matchId).get();
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "playing") throw new Error("当前状态不能选择结果");

    const participants = dedupeParticipants(match.participants || []);
    if (!participants.some((p) => p.openid === openid)) {
      throw new Error("你不在此球局中");
    }

    const updated = participants.map((p) => {
      if (p.openid === openid) return { ...p, resultChoice: choice };
      return p;
    });

    const bothSelected = updated.every((p) => p.resultChoice != null);
    if (!bothSelected) {
      await transaction.collection("matches").doc(matchId).update({ data: { participants: updated } });
      result = { code: "ok", bothSelected: false };
      return;
    }

    const settlement = buildSettlement(match, updated);
    if (!settlement.consistent) {
      await transaction.collection("matches").doc(matchId).update({
        data: {
          participants: updated.map((p) => ({ ...p, resultChoice: null })),
          conflictAt: db.serverDate()
        }
      });
      result = { code: "conflict", bothSelected: false };
      return;
    }

    const winnerFrozen = getFrozenAmount(settlement.winner);
    const loserFrozen = getFrozenAmount(settlement.loser);
    const finalParticipants = updated.map((p) => ({ ...p, yuedouFrozen: 0 }));

    await transaction.collection("matches").doc(matchId).update({
      data: {
        status: "settled",
        participants: finalParticipants,
        finalParticipants: settlement.finalParticipants
      }
    });

    await updateUserByOpenid(transaction, userMap, settlement.winner.openid, {
      yuedou: _.inc(winnerFrozen + YUEDOU_WINNER),
      yuedouFrozen: _.inc(-winnerFrozen),
      yuedouSystem: _.inc(YUEDOU_SYSTEM)
    });
    await updateUserByOpenid(transaction, userMap, settlement.loser.openid, {
      yuedouFrozen: _.inc(-loserFrozen)
    });

    const venueId = match.venueId || null;
    await transaction.collection("score_records").add({
      data: {
        userId: settlement.winner.openid,
        type: "match_win",
        amount: YUEDOU_WINNER,
        venueId,
        matchId,
        createdAt: db.serverDate()
      }
    });
    await transaction.collection("score_records").add({
      data: {
        userId: settlement.loser.openid,
        type: "match_lose",
        amount: -YUEDOU_FROZEN,
        venueId,
        matchId,
        createdAt: db.serverDate()
      }
    });

    for (const uid of uniqueOpenids(updated.map((p) => p.openid))) {
      await updateUserByOpenid(transaction, userMap, uid, {
        score: _.inc(SCORE_COMPLETE_MATCH)
      });
    }

    const winnerNick = settlement.winner.nickname || "某用户";
    const loserNick = settlement.loser.nickname || "某用户";
    noticePayloads = [
      { type: "match_settled", targetOpenid: settlement.winner.openid, matchId, content: `🏆 你赢了「${loserNick}」！获得 ${YUEDOU_WINNER} 约豆` },
      { type: "match_settled", targetOpenid: settlement.loser.openid, matchId, content: `😅 你输了「${winnerNick}」，冻结的 ${YUEDOU_FROZEN} 约豆已扣除` }
    ];
    result = { code: "ok", bothSelected: true };
  });

  for (const notice of noticePayloads) {
    try { await addNotice(notice); } catch (e) { console.error("结算通知发送失败", e); }
  }

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
async function doSettleMatch(matchId, match, participants) {
  const settlement = buildSettlement(match, participants);
  if (!settlement.consistent) throw new Error("结果不一致，不能结算");

  const winnerFrozen = getFrozenAmount(settlement.winner);
  const loserFrozen = getFrozenAmount(settlement.loser);
  const finalParticipants = dedupeParticipants(participants).map((p) => ({ ...p, yuedouFrozen: 0 }));
  const userMap = await getUserMap(finalParticipants.map((p) => p.openid));

  await db.runTransaction(async (transaction) => {
    await transaction.collection("matches").doc(matchId).update({
      data: {
        status: "settled",
        participants: finalParticipants,
        finalParticipants: settlement.finalParticipants
      }
    });
    await updateUserByOpenid(transaction, userMap, settlement.winner.openid, {
      yuedou: _.inc(winnerFrozen + YUEDOU_WINNER),
      yuedouFrozen: _.inc(-winnerFrozen),
      yuedouSystem: _.inc(YUEDOU_SYSTEM)
    });
    await updateUserByOpenid(transaction, userMap, settlement.loser.openid, {
      yuedouFrozen: _.inc(-loserFrozen)
    });
  });

  await addScoreRecord(settlement.winner.openid, "match_win", YUEDOU_WINNER, match.venueId || null, matchId);
  await addScoreRecord(settlement.loser.openid, "match_lose", -YUEDOU_FROZEN, match.venueId || null, matchId);

  for (const oid of uniqueOpenids(finalParticipants.map((p) => p.openid))) {
    try { await recordMatchComplete(oid); } catch (_) {}
  }
}

// ── 强制关闭 / 商家取消 ──────────────────────────────────────
async function doClose(openid, matchId) {
  let targetOpenid = null;
  let noticeContent = "";
  const preMatch = await getMatch(matchId);
  if (!preMatch) throw new Error("球局不存在");
  const userMap = await getUserMap(dedupeParticipants(preMatch.participants || []).map((p) => p.openid));

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.collection("matches").doc(matchId).get();
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可关闭");

    const participants = dedupeParticipants(match.participants || []);
    const isHost = match.hostOpenid === openid;
    const isParticipant = participants.some((p) => p.openid === openid);
    if (!isHost && !isParticipant) throw new Error("你无权关闭此球局");

    if (match.status === "recruiting" && !isHost) {
      throw new Error("仅发起人可关闭招募中的球局");
    }
    if (match.status === "playing") {
      const startedAt = toMillis(match.startedAt);
      const sixHours = 6 * 60 * 60 * 1000;
      if (!startedAt || Date.now() - startedAt < sixHours) {
        throw new Error("比赛开始超过6小时后才能强制关闭");
      }
    }

    const refundedParticipants = await refundFrozenInTransaction(transaction, userMap, participants);
    await transaction.collection("matches").doc(matchId).update({
      data: {
        status: "cancelled",
        participants: refundedParticipants,
        headcountJoined: refundedParticipants.length,
        closedAt: db.serverDate(),
        closedBy: openid
      }
    });

    targetOpenid = match.hostOpenid;
    noticeContent = match.status === "recruiting"
      ? `你发起的「${match.venueName || "球局"}」已关闭，冻结约豆已退还`
      : `「${match.venueName || "球局"}」因超时关闭，冻结约豆已退还`;
  });

  if (targetOpenid) {
    await addNotice({ type: "match_closed", targetOpenid, matchId, content: noticeContent });
  }
  return { code: "closed" };
}

async function doCancelByVenueOwner(openid, matchId) {
  let noticeTargets = [];
  const preMatch = await getMatch(matchId);
  if (!preMatch) throw new Error("球局不存在");
  const userMap = await getUserMap(dedupeParticipants(preMatch.participants || []).map((p) => p.openid));

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.collection("matches").doc(matchId).get();
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可取消");

    const venueRecord = await transaction.collection("venues").doc(match.venueId).get();
    const venue = venueRecord.data;
    if (!venue || venue.ownerOpenid !== openid) {
      throw new Error("只有球房商家可取消本店球局");
    }

    const participants = dedupeParticipants(match.participants || []);
    const refundedParticipants = await refundFrozenInTransaction(transaction, userMap, participants);
    await transaction.collection("matches").doc(matchId).update({
      data: {
        status: "cancelled",
        participants: refundedParticipants,
        headcountJoined: refundedParticipants.length,
        closedAt: db.serverDate(),
        closedBy: openid,
        closedByRole: "venue_owner"
      }
    });
    noticeTargets = uniqueOpenids([match.hostOpenid, ...participants.map((p) => p.openid)]);
  });

  for (const targetOpenid of noticeTargets) {
    try {
      await addNotice({
        type: "match_canceled",
        targetOpenid,
        matchId,
        content: "商家已取消这场球局，冻结约豆已退还"
      });
    } catch (e) {
      console.error("商家取消通知发送失败", e);
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

exports.__test__ = {
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_SYSTEM,
  buildSettlement,
  dedupeParticipants,
  getFrozenAmount,
  positiveAmount,
  uniqueOpenids
};
