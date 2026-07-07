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
const economy = require("./economy");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 约豆常量（与 utils/cloudDB.js 保持一致）
const YUEDOU_INITIAL = 10000;
const YUEDOU_FROZEN  = economy.YUEDOU_FROZEN;
const YUEDOU_WINNER  = economy.YUEDOU_WINNER;   // 赢家获得
const YUEDOU_SYSTEM  = economy.YUEDOU_SYSTEM;   // 系统抽成

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

async function getUserByOpenidInTransaction(transaction, openid) {
  const res = await transaction.get(db.collection("yueqiu8_users").where({ openid }));
  return res.data && res.data[0] ? res.data[0] : null;
}

async function getUserDocRefInTransaction(transaction, openid) {
  const user = await getUserByOpenidInTransaction(transaction, openid);
  if (!user) throw new Error("用户不存在，请先登录");
  return { user, ref: db.collection("yueqiu8_users").doc(user._id) };
}

function normalizeParticipants(participants) {
  return (participants || []).filter((p) => p && p.openid);
}

function clearFrozenInParticipants(participants) {
  return normalizeParticipants(participants).map((p) => ({ ...p, yuedouFrozen: 0 }));
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

  let matchId = null;
  await db.runTransaction(async (transaction) => {
    const { user, ref: userRef } = await getUserDocRefInTransaction(transaction, openid);
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

    await transaction.update(userRef, {
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  });

  if (matchData.venueId && matchId) {
    await recordVenueAccess(openid, matchData.venueId, matchId).catch((e) => {
      console.error("记录球房访问失败", e);
    });
  }

  return { code: "ok", matchId };
}

// ── 加入球局 ───────────────────────────────────────────────
async function doJoin(openid, matchId) {
  let venueId = null;
  let result = { code: "ok" };

  await db.runTransaction(async (transaction) => {
    const { user, ref: userRef } = await getUserDocRefInTransaction(transaction, openid);
    const yuedou = user.yuedou ?? YUEDOU_INITIAL;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法加入约局");

    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") throw new Error("该球局已不在招募中，无法加入");

    const participants = normalizeParticipants(match.participants);
    venueId = match.venueId || null;
    if (participants.some((p) => p.openid === openid)) {
      result = { code: "already_joined" };
      return;
    }

    const target = match.headcountTarget || 2;
    if (participants.length >= target || (match.headcountJoined ?? participants.length) >= target) {
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
    const nextParticipants = participants.concat(addedParticipant);

    await transaction.update(matchRef, {
      data: {
        participants: nextParticipants,
        headcountJoined: nextParticipants.length
      }
    });
    await transaction.update(userRef, {
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  });

  if (result.code === "ok" && venueId) {
    await recordVenueAccess(openid, venueId, matchId).catch((e) => {
      console.error("记录球房访问失败", e);
    });
  }

  return result;
}

// ── 退出球局 ───────────────────────────────────────────────
async function doLeave(openid, matchId) {
  let result = { code: "left" };

  await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");

    const participants = normalizeParticipants(match.participants);
    const me = participants.find((p) => p.openid === openid);
    if (!me) throw new Error("你不在此球局中，无法退出");

    if (match.status !== "recruiting") {
      throw new Error("比赛已开始或已结束，不能退出");
    }

    if (match.hostOpenid === openid) {
      for (const p of participants) {
        const frozenAmount = economy.getParticipantStake(p);
        if (frozenAmount <= 0) continue;
        const { ref: userRef } = await getUserDocRefInTransaction(transaction, p.openid);
        await transaction.update(userRef, {
          data: {
            yuedou: _.inc(frozenAmount),
            yuedouFrozen: _.inc(-frozenAmount)
          }
        });
      }
      await transaction.remove(matchRef);
      result = { code: "canceled_by_host" };
      return;
    }

    const frozenAmount = economy.getParticipantStake(me);
    const nextParticipants = participants.filter((p) => p.openid !== openid);
    await transaction.update(matchRef, {
      data: {
        participants: nextParticipants,
        headcountJoined: nextParticipants.length
      }
    });
    if (frozenAmount > 0) {
      const { ref: userRef } = await getUserDocRefInTransaction(transaction, openid);
      await transaction.update(userRef, {
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
    }).catch((e) => console.error("退出通知写入失败", e));
  }

  return result;
}

// ── 确认比赛开始 ───────────────────────────────────────────
async function doConfirm(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.hostOpenid !== openid) throw new Error("仅发起人可确认");
  if (match.status !== "recruiting") throw new Error("当前状态不可确认");

  const participants = normalizeParticipants(match.participants);
  economy.assertTwoPlayerMatch(match, participants);
  if (participants.length < (match.headcountTarget || 2)) {
    throw new Error("球局未满员，不能开始");
  }

  const allVerified = participants.every((p) => p.locationVerified);
  if (!allVerified) throw new Error("双方需先完成位置校验后才能开始比赛");

  await db.collection("matches").doc(matchId).update({
    data: { status: "playing", startedAt: db.serverDate() }
  });

  const allOpenids = economy.getUniqueOpenids(participants);
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

  let settlementInfo = null;
  const result = await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "playing") throw new Error("当前状态不能选择结果");

    const participants = normalizeParticipants(match.participants);
    economy.assertTwoPlayerMatch(match, participants);

    const pIdx = participants.findIndex((p) => p.openid === openid);
    if (pIdx < 0) throw new Error("你不在此球局中");
    if (participants[pIdx].resultChoice && participants[pIdx].resultChoice !== choice) {
      throw new Error("结果已提交，不能重复修改");
    }

    const updated = participants.map((p) => {
      if (p.openid === openid) return { ...p, resultChoice: choice };
      return p;
    });

    const bothSelected = updated.every((p) => p.resultChoice != null);
    if (!bothSelected) {
      await transaction.update(matchRef, { data: { participants: updated } });
      return { code: "ok", bothSelected: false };
    }

    const settlement = economy.buildSettlement(match, updated);
    if (!settlement) {
      await transaction.update(matchRef, {
        data: {
          participants: updated.map((p) => ({ ...p, resultChoice: null })),
          conflictAt: db.serverDate()
        }
      });
      return { code: "conflict", bothSelected: false };
    }

    const { ref: winnerRef } = await getUserDocRefInTransaction(transaction, settlement.winnerId);
    const { ref: loserRef } = await getUserDocRefInTransaction(transaction, settlement.loserId);

    await transaction.update(matchRef, {
      data: {
        status: "settled",
        participants: clearFrozenInParticipants(updated),
        finalParticipants: updated.map((p) => ({
          openid: p.openid,
          nickname: p.nickname,
          resultChoice: p.resultChoice
        })),
        settledAt: db.serverDate()
      }
    });
    await transaction.update(winnerRef, {
      data: {
        yuedou: _.inc(settlement.winnerGain),
        yuedouFrozen: _.inc(-settlement.winnerStake),
        yuedouSystem: _.inc(YUEDOU_SYSTEM)
      }
    });
    await transaction.update(loserRef, {
      data: {
        yuedou: _.inc(settlement.loserGain),
        yuedouFrozen: _.inc(-settlement.loserStake),
        yuedouSystem: _.inc(YUEDOU_SYSTEM)
      }
    });
    await transaction.add(db.collection("score_records"), {
      data: {
        userId: settlement.winnerId,
        type: "match_win",
        amount: YUEDOU_WINNER,
        venueId: match.venueId || null,
        matchId,
        createdAt: db.serverDate()
      }
    });
    await transaction.add(db.collection("score_records"), {
      data: {
        userId: settlement.loserId,
        type: "match_lose",
        amount: 0,
        venueId: match.venueId || null,
        matchId,
        createdAt: db.serverDate()
      }
    });

    settlementInfo = {
      ...settlement,
      participants: updated,
      openids: economy.getUniqueOpenids(updated)
    };
    return { code: "ok", bothSelected: true };
  });

  if (settlementInfo) {
    const winnerNick = settlementInfo.participants.find((p) => p.openid === settlementInfo.winnerId)?.nickname || "某用户";
    const loserNick = settlementInfo.participants.find((p) => p.openid === settlementInfo.loserId)?.nickname || "某用户";
    await addNotice({ type: "match_settled", targetOpenid: settlementInfo.winnerId, matchId, content: `🏆 你赢了「${loserNick}」！获得+${YUEDOU_WINNER}约豆，冻结约豆已解冻` }).catch((e) => console.error("赢家通知失败", e));
    await addNotice({ type: "match_settled", targetOpenid: settlementInfo.loserId, matchId, content: `😅 你输了「${winnerNick}」，冻结约豆已扣除` }).catch((e) => console.error("输家通知失败", e));
    for (const oid of settlementInfo.openids) {
      await recordMatchComplete(oid).catch((e) => console.error("完成比赛积分记录失败", e));
    }
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
  // 保留函数名是为了兼容旧注释；真正结算统一在 doSubmitResult 的事务里完成。
  // 这里不再做任何写库，避免后续误调用造成重复派奖。
  throw new Error(`doSettleMatch 已废弃，请通过 submitResult 结算：${matchId}`);
}

async function refundParticipantsInTransaction(transaction, participants) {
  const unique = new Map();
  normalizeParticipants(participants).forEach((p) => {
    if (!p.openid || unique.has(p.openid)) return;
    unique.set(p.openid, p);
  });

  for (const p of unique.values()) {
    const frozenAmount = economy.getParticipantStake(p);
    if (frozenAmount <= 0) continue;
    const { ref: userRef } = await getUserDocRefInTransaction(transaction, p.openid);
    await transaction.update(userRef, {
      data: {
        yuedou: _.inc(frozenAmount),
        yuedouFrozen: _.inc(-frozenAmount)
      }
    });
  }
}

async function doClose(openid, matchId) {
  let notice = null;
  await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可关闭");

    const participants = normalizeParticipants(match.participants);
    const isHost = match.hostOpenid === openid;
    const isParticipant = participants.some((p) => p.openid === openid);
    if (!isHost && !isParticipant) throw new Error("你无权关闭此球局");

    if (match.status === "recruiting") {
      if (!isHost) throw new Error("仅发起人可关闭招募中的球局");
      if (!match.startAt || new Date(match.startAt).getTime() > Date.now()) {
        throw new Error("未到开赛时间，不能关闭招募中的球局");
      }
    }

    if (match.status === "playing" && !economy.canForceClosePlaying(match.startedAt)) {
      throw new Error("比赛开始未超过6小时，不能强制关闭");
    }

    await refundParticipantsInTransaction(transaction, participants);
    await transaction.update(matchRef, {
      data: {
        status: "cancelled",
        participants: clearFrozenInParticipants(participants),
        closedAt: db.serverDate(),
        closedBy: openid
      }
    });

    notice = {
      type: match.status === "recruiting" ? "match_canceled" : "match_closed",
      targetOpenid: match.hostOpenid,
      matchId,
      content: match.status === "recruiting"
        ? `你发起的「${match.venueName}」球局已关闭`
        : `「${match.venueName}」球局因超时被关闭，冻结约豆已解冻`
    };
  });

  if (notice) {
    await addNotice(notice).catch((e) => console.error("关闭球局通知失败", e));
  }
  return { code: "closed" };
}

async function doCancelByVenueOwner(openid, matchId) {
  let noticeTargets = [];
  await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchSnap = await transaction.get(matchRef);
    const match = matchSnap.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) {
      throw new Error("当前状态不可取消");
    }
    if (!match.venueId) throw new Error("球局缺少球房信息");

    const venueSnap = await transaction.get(db.collection("venues").doc(match.venueId));
    const venue = venueSnap.data;
    if (!venue || venue.ownerOpenid !== openid) {
      throw new Error("仅球房商家可取消本店球局");
    }

    const participants = normalizeParticipants(match.participants);
    await refundParticipantsInTransaction(transaction, participants);
    await transaction.update(matchRef, {
      data: {
        status: "cancelled",
        participants: clearFrozenInParticipants(participants),
        cancelledAt: db.serverDate(),
        cancelledBy: openid,
        cancelReason: "venue_owner"
      }
    });
    noticeTargets = economy.getUniqueOpenids(participants).map((targetOpenid) => ({
      type: "match_canceled",
      targetOpenid,
      matchId,
      content: `「${match.venueName || "球局"}」已由球房商家取消，冻结约豆已退回`
    }));
  });

  for (const notice of noticeTargets) {
    await addNotice(notice).catch((e) => console.error("商家取消通知失败", e));
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
