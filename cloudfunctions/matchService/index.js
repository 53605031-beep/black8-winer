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
const {
  YUEDOU_INITIAL,
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_SYSTEM,
  buildFinalParticipants,
  buildSettlement,
  getDistinctParticipants,
  getFrozenAmount
} = require("./economyRules");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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

function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.getTime === "function") return value.getTime();
  if (value.$date) return new Date(value.$date).getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getUserFromQueryResult(result) {
  return (result && result.data && result.data[0]) || null;
}

async function getUserByOpenidTx(transaction, openid) {
  const res = await transaction.get(db.collection("yueqiu8_users").where({ openid }));
  return getUserFromQueryResult(res);
}

function uniqueOpenids(openids) {
  const seen = {};
  return (openids || []).filter((openid) => {
    if (!openid || seen[openid]) return false;
    seen[openid] = true;
    return true;
  });
}

function isActiveMatch(match) {
  return match && (match.status === "recruiting" || match.status === "playing");
}

async function refundFrozenInTransaction(transaction, participants) {
  for (const p of participants || []) {
    const frozen = getFrozenAmount(p);
    if (!p.openid || frozen <= 0) continue;
    await transaction.update(db.collection("yueqiu8_users").where({ openid: p.openid }), {
      data: {
        yuedou: _.inc(frozen),
        yuedouFrozen: _.inc(-frozen)
      }
    });
  }
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
  if (headcountTarget < 2) throw new Error("每局至少需要2人");
  if (!matchData.startAt) throw new Error("请选择开局时间");
  if (!matchData.venueId) throw new Error("请选择球房");

  let createdMatchId = null;
  await db.runTransaction(async (transaction) => {
    const user = await getUserByOpenidTx(transaction, openid);
    if (!user) throw new Error("用户不存在，请先登录");

    const activeRes = await transaction.get(db.collection("matches").where(
      _.or(
        { hostOpenid: openid },
        { participants: _.elemMatch({ openid }) }
      )
    ));
    const hasActive = (activeRes.data || []).some(isActiveMatch);
    if (hasActive) throw new Error("你已有进行中的球局，请先结束后再发起");

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
    createdMatchId = matchRes._id;

    await transaction.update(db.collection("yueqiu8_users").where({ openid }), {
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  });

  // 记录球房访问不影响主账务，失败时让用户发布成功不被回滚。
  if (matchData.venueId) {
    try { await recordVenueAccess(openid, matchData.venueId, createdMatchId); } catch (e) {
      console.error("记录球房访问失败", e);
    }
  }

  return { code: "ok", matchId: createdMatchId };
}

// ── 加入球局 ───────────────────────────────────────────────
async function doJoin(openid, matchId) {
  let joinResult = { code: "ok" };
  let venueId = null;

  await db.runTransaction(async (transaction) => {
    const user = await getUserByOpenidTx(transaction, openid);
    if (!user) throw new Error("用户不存在，请先登录");

    const activeRes = await transaction.get(db.collection("matches").where(
      _.or(
        { hostOpenid: openid },
        { participants: _.elemMatch({ openid }) }
      )
    ));
    const hasOtherActive = (activeRes.data || []).some((m) => m._id !== matchId && isActiveMatch(m));
    if (hasOtherActive) throw new Error("你已有进行中的球局，请先结束后再加入");

    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") throw new Error("该球局已不在招募中，无法加入");

    const participants = getDistinctParticipants(match.participants || []);
    if (participants.some((p) => p.openid === openid)) {
      joinResult = { code: "already_joined" };
      return;
    }

    const headcountTarget = match.headcountTarget || 2;
    if (participants.length >= headcountTarget || (match.headcountJoined ?? 0) >= headcountTarget) {
      throw new Error("该球局已满员");
    }

    const yuedou = user.yuedou ?? YUEDOU_INITIAL;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法加入约局");

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
    const nextParticipants = participants.concat(addedParticipant);
    venueId = match.venueId;

    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        participants: nextParticipants,
        headcountJoined: nextParticipants.length
      }
    });
    await transaction.update(db.collection("yueqiu8_users").where({ openid }), {
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  });

  if (joinResult.code === "ok" && venueId) {
    try { await recordVenueAccess(openid, venueId, matchId); } catch (e) {
      console.error("记录球房访问失败", e);
    }
  }

  return joinResult;
}

// ── 退出球局 ───────────────────────────────────────────────
async function doLeave(openid, matchId) {
  let result = { code: "left" };

  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") throw new Error("比赛已开始或已结束，不能退出");

    const participants = getDistinctParticipants(match.participants || []);
    const me = participants.find((p) => p.openid === openid);
    if (!me) throw new Error("你不在此球局中，无法退出");

    if (match.hostOpenid === openid) {
      await refundFrozenInTransaction(transaction, participants);
      await transaction.update(db.collection("matches").doc(matchId), {
        data: {
          status: "cancelled",
          cancelledAt: db.serverDate(),
          cancelledBy: openid,
          cancelReason: "host_leave",
          participants: buildFinalParticipants(participants)
        }
      });
      result = { code: "canceled_by_host" };
      return;
    }

    const frozenAmount = getFrozenAmount(me);
    const nextParticipants = participants.filter((p) => p.openid !== openid);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        participants: nextParticipants,
        headcountJoined: nextParticipants.length
      }
    });
    if (frozenAmount > 0) {
      await transaction.update(db.collection("yueqiu8_users").where({ openid }), {
        data: {
          yuedou: _.inc(frozenAmount),
          yuedouFrozen: _.inc(-frozenAmount)
        }
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
  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.hostOpenid !== openid) throw new Error("仅发起人可确认");
    if (match.status !== "recruiting") throw new Error("当前状态不可确认");

    const participants = getDistinctParticipants(match.participants || []);
    const headcountTarget = match.headcountTarget || 2;
    if (participants.length < headcountTarget) throw new Error("人数未满，不能开始比赛");

    const allVerified = participants.every((p) => p.locationVerified);
    if (!allVerified) throw new Error("双方需先完成位置校验后才能开始比赛");

    await transaction.update(db.collection("matches").doc(matchId), {
      data: { status: "playing", startedAt: db.serverDate(), participants, headcountJoined: participants.length }
    });

    const allOpenids = uniqueOpenids([match.hostOpenid].concat(participants.map((p) => p.openid)));
    for (const uid of allOpenids) {
      const user = await getUserByOpenidTx(transaction, uid);
      if (!user) continue;

      let weeklyMatches = (user.weeklyMatches || 0) + 1;
      let monthlyMatches = (user.monthlyMatches || 0) + 1;
      const weekStart = _weekStartStr();
      const monthStart = _monthStartStr();
      if ((user.weeklyResetAt || "") < weekStart) weeklyMatches = 1;
      if ((user.monthlyResetAt || "") < monthStart) monthlyMatches = 1;

      await transaction.update(db.collection("yueqiu8_users").where({ openid: uid }), {
        data: {
          score: _.inc(uid === match.hostOpenid ? SCORE_CREATE_MATCH : SCORE_JOIN_MATCH),
          weeklyMatches,
          monthlyMatches,
          weeklyResetAt: (user.weeklyResetAt || "") < weekStart ? weekStart : user.weeklyResetAt,
          monthlyResetAt: (user.monthlyResetAt || "") < monthStart ? monthStart : user.monthlyResetAt,
          weeklyClaimed: (user.weeklyResetAt || "") < weekStart ? false : user.weeklyClaimed,
          monthlyClaimed: (user.monthlyResetAt || "") < monthStart ? false : user.monthlyClaimed
        }
      });
    }
  });

  return { code: "ok" };
}

// ── 提交结果选择 ───────────────────────────────────────────
async function doSubmitResult(openid, matchId, choice) {
  const validChoices = ["win", "lose"];
  if (!validChoices.includes(choice)) throw new Error("无效的选择");

  let result = { code: "ok", bothSelected: false };
  const notices = [];

  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.status === "settled" || match.status === "finished") {
      result = { code: "already_settled", bothSelected: true };
      return;
    }
    if (match.status !== "playing") throw new Error("当前状态不能选择结果");

    const participants = getDistinctParticipants(match.participants || []);
    if (participants.length !== 2) throw new Error("当前只支持两人球局结算");
    if (!participants.some((p) => p.openid === openid)) throw new Error("你不在此球局中");

    const updated = participants.map((p) => {
      if (p.openid === openid) return { ...p, resultChoice: choice };
      return p;
    });

    const bothSelected = updated.every((p) => p.resultChoice != null);
    if (!bothSelected) {
      await transaction.update(db.collection("matches").doc(matchId), {
        data: { participants: updated, headcountJoined: updated.length }
      });
      result = { code: "ok", bothSelected: false };
      return;
    }

    const settlement = buildSettlement(match, updated);
    if (!settlement.consistent) {
      await transaction.update(db.collection("matches").doc(matchId), {
        data: {
          participants: updated.map((p) => ({ ...p, resultChoice: null })),
          conflictAt: db.serverDate()
        }
      });
      result = { code: "conflict", bothSelected: false };
      return;
    }

    const finalParticipants = buildFinalParticipants(updated);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "settled",
        participants: finalParticipants,
        headcountJoined: finalParticipants.length,
        settledAt: db.serverDate(),
        finalParticipants: finalParticipants.map((p) => ({
          openid: p.openid,
          nickname: p.nickname,
          resultChoice: p.resultChoice
        }))
      }
    });

    await transaction.update(db.collection("yueqiu8_users").where({ openid: settlement.winnerId }), {
      data: {
        yuedou: _.inc(settlement.winnerLiquidDelta),
        yuedouFrozen: _.inc(settlement.winnerFrozenDelta),
        yuedouSystem: _.inc(settlement.systemAmount),
        score: _.inc(SCORE_COMPLETE_MATCH)
      }
    });
    await transaction.update(db.collection("yueqiu8_users").where({ openid: settlement.loserId }), {
      data: {
        yuedou: _.inc(settlement.loserLiquidDelta),
        yuedouFrozen: _.inc(settlement.loserFrozenDelta),
        yuedouSystem: _.inc(settlement.systemAmount),
        score: _.inc(SCORE_COMPLETE_MATCH)
      }
    });

    await transaction.add(db.collection("score_records"), {
      data: {
        userId: settlement.winnerId,
        type: "match_win",
        amount: settlement.scoreRecordAmount,
        venueId: match.venueId || null,
        matchId,
        createdAt: db.serverDate()
      }
    });
    await transaction.add(db.collection("score_records"), {
      data: {
        userId: settlement.loserId,
        type: "match_lose",
        amount: -settlement.loserFrozen,
        venueId: match.venueId || null,
        matchId,
        createdAt: db.serverDate()
      }
    });

    const winnerNick = updated.find((p) => p.openid === settlement.winnerId)?.nickname || "某用户";
    const loserNick = updated.find((p) => p.openid === settlement.loserId)?.nickname || "某用户";
    notices.push(
      { type: "match_settled", targetOpenid: settlement.winnerId, matchId, content: `你赢了「${loserNick}」！获得${YUEDOU_WINNER}约豆，冻结约豆已解冻` },
      { type: "match_settled", targetOpenid: settlement.loserId, matchId, content: `你输了「${winnerNick}」，冻结约豆已结算` }
    );
    result = { code: "ok", bothSelected: true };
  });

  for (const notice of notices) {
    await addNotice(notice);
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

// ── 关闭/取消球局 ───────────────────────────────────────────
async function doClose(openid, matchId) {
  let notice = null;

  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可关闭");

    const participants = getDistinctParticipants(match.participants || []);
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
        throw new Error("比赛开始未超过6小时，暂不能强制关闭");
      }
    }

    await refundFrozenInTransaction(transaction, participants);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "cancelled",
        closedAt: db.serverDate(),
        closedBy: openid,
        participants: buildFinalParticipants(participants),
        headcountJoined: participants.length
      }
    });

    notice = {
      type: match.status === "recruiting" ? "match_canceled" : "match_closed",
      targetOpenid: match.hostOpenid,
      matchId,
      venueId: match.venueId || null,
      content: match.status === "recruiting"
        ? `你发起的「${match.venueName || "球局"}」已关闭，冻结约豆已退还`
        : `「${match.venueName || "球局"}」因超时被关闭，冻结约豆已退还`
    };
  });

  if (notice) await addNotice(notice);
  return { code: "closed" };
}

async function doCancelByVenueOwner(openid, matchId) {
  let noticeTargets = [];

  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可取消");
    if (!match.venueId) throw new Error("球局缺少球房信息");

    const venueRes = await transaction.get(db.collection("venues").doc(match.venueId));
    const venue = venueRes.data;
    if (!venue) throw new Error("球房不存在");
    if (venue.ownerOpenid !== openid) throw new Error("只有球房商家可取消本店球局");

    const participants = getDistinctParticipants(match.participants || []);
    await refundFrozenInTransaction(transaction, participants);
    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "cancelled",
        cancelledAt: db.serverDate(),
        cancelledBy: openid,
        cancelReason: "venue_owner",
        participants: buildFinalParticipants(participants),
        headcountJoined: participants.length
      }
    });

    noticeTargets = uniqueOpenids(participants.map((p) => p.openid));
  });

  for (const targetOpenid of noticeTargets) {
    await addNotice({
      type: "match_canceled",
      targetOpenid,
      matchId,
      content: "球房商家已取消球局，冻结约豆已退还"
    });
  }

  return { code: "cancelled" };
}

// ── 结算 ───────────────────────────────────────────────────
async function doSettleMatch(matchId, match, participants) {
  throw new Error("结算必须通过 doSubmitResult 的事务流程执行");
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
