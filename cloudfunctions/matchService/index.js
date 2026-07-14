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
 *   close            关闭过期/异常球局并退还冻结约豆
 *   cancelByVenueOwner 商家取消本店球局并退还冻结约豆
 *   submitResult     提交比赛结果选择
 *   verifyLocation  校验位置
 *   publish          发布新球局（与 join 同级）
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const _ = db.command;

// 约豆常量（与 utils/cloudDB.js 保持一致）
const YUEDOU_INITIAL = 10000;
const YUEDOU_FROZEN  = 500;
const YUEDOU_WINNER  = 420;   // 赢家获得
const YUEDOU_LOSER   = 500;   // 输家已冻结的输局金额
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

function isActiveStatus(status) {
  return status === "recruiting" || status === "playing";
}

async function getActiveMatchesForOpenid(openid, excludeMatchId) {
  const res = await db.collection("matches")
    .where(_.or(
      { hostOpenid: openid },
      { participants: _.elemMatch({ openid }) }
    ))
    .get();
  return (res.data || []).filter((match) => {
    if (excludeMatchId && match._id === excludeMatchId) return false;
    return isActiveStatus(match.status);
  });
}

async function clearStaleActiveMatch(user) {
  if (!user || !user.activeMatchId) return;
  try {
    const activeMatch = await getMatch(user.activeMatchId);
    if (activeMatch && isActiveStatus(activeMatch.status)) {
      throw new Error("你已有进行中或招募中的球局，请先处理后再继续");
    }
    await db.collection("yueqiu8_users").doc(user._id).update({
      data: { activeMatchId: null }
    });
  } catch (e) {
    if (e.message && e.message.includes("已有进行中")) throw e;
    await db.collection("yueqiu8_users").doc(user._id).update({
      data: { activeMatchId: null }
    });
  }
}

async function assertNoActiveMatch(openid, excludeMatchId) {
  const activeMatches = await getActiveMatchesForOpenid(openid, excludeMatchId);
  if (activeMatches.length > 0) {
    throw new Error("你已有进行中或招募中的球局，请先处理后再继续");
  }
}

function getFrozenAmount(participant) {
  if (!participant) return 0;
  const amount = participant.yuedouFrozen == null ? YUEDOU_FROZEN : Number(participant.yuedouFrozen);
  return amount > 0 ? amount : 0;
}

function clearParticipantFrozen(participants) {
  return (participants || []).map((p) => ({ ...p, yuedouFrozen: 0 }));
}

async function getUserIdsByOpenid(openids) {
  const result = {};
  const uniqueOpenids = Array.from(new Set((openids || []).filter(Boolean)));
  for (const openid of uniqueOpenids) {
    const user = await getUserByOpenid(openid);
    if (user && user._id) result[openid] = user._id;
  }
  return result;
}

async function getUserInTransaction(transaction, userId) {
  if (!userId) return null;
  const res = await transaction.collection("yueqiu8_users").doc(userId).get();
  return res.data || null;
}

function getParticipantUserId(participant, userIdsByOpenid) {
  return participant.userDocId || userIdsByOpenid[participant.openid];
}

async function refundFrozenParticipants(transaction, participants, userIdsByOpenid) {
  const refunded = new Set();
  for (const participant of participants || []) {
    const openid = participant.openid;
    const frozen = getFrozenAmount(participant);
    if (!openid || frozen <= 0 || refunded.has(openid)) continue;

    const user = await getUserInTransaction(transaction, getParticipantUserId(participant, userIdsByOpenid));
    if (!user) throw new Error("参与者用户数据不存在，无法自动退款");
    if ((Number(user.yuedouFrozen) || 0) < frozen) {
      throw new Error("参与者冻结约豆数据异常，无法自动退款");
    }
    refunded.add(openid);
    // 只退这场球局记录里的冻结额，避免误退用户其它球局的冻结约豆。
    await transaction.collection("yueqiu8_users").doc(user._id).update({
      data: {
        yuedou: _.inc(frozen),
        yuedouFrozen: _.inc(-frozen),
        activeMatchId: null
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

function getVenueCoordinates(venue) {
  if (!venue) return null;
  const location = venue.location || {};
  const coordinates = location.coordinates || [];
  const latitude = Number(
    venue._locationPlain?.latitude ?? coordinates[1] ?? venue.latitude
  );
  const longitude = Number(
    venue._locationPlain?.longitude ?? coordinates[0] ?? venue.longitude
  );
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
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

// ── 发布球局 ───────────────────────────────────────────────
async function doPublish(openid, matchData) {
  const headcountTarget = matchData.headcountTarget || 2;
  if (headcountTarget < 2) throw new Error("每局至少需要2人");
  if (!matchData.startAt) throw new Error("请选择开局时间");
  if (!matchData.venueId) throw new Error("请选择球房");

  const existingUser = await getUserByOpenid(openid);
  if (!existingUser || !existingUser._id) throw new Error("用户不存在，请先登录");
  await clearStaleActiveMatch(existingUser);
  await assertNoActiveMatch(openid);

  let matchId = "";
  await db.runTransaction(async (transaction) => {
    const user = await getUserInTransaction(transaction, existingUser._id);
    if (!user) throw new Error("用户不存在，请先登录");
    if (user.activeMatchId) throw new Error("你已有进行中或招募中的球局，请先处理后再继续");

    const yuedou = Number(user.yuedou) || 0;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法发起约局");

    const nickname = user.nickname || "匿名用户";
    const avatar = user.avatarUrl || "";
    const matchRes = await transaction.collection("matches").add({
      data: {
        ...matchData,
        hostOpenid: openid,
        hostNickname: nickname,
        participants: [{
          openid,
          userDocId: user._id,
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

    await transaction.collection("yueqiu8_users").doc(user._id).update({
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN),
        activeMatchId: matchId
      }
    });
  });

  // 记录球房访问不影响约豆冻结事务，失败不回滚发布。
  if (matchData.venueId) {
    try { await recordVenueAccess(openid, matchData.venueId, matchId); } catch (e) { console.error("记录球房访问失败", e); }
  }

  return { code: "ok", matchId };
}

// ── 加入球局 ───────────────────────────────────────────────
async function doJoin(openid, matchId) {
  let result = { code: "ok" };
  let venueId = null;
  const existingUser = await getUserByOpenid(openid);
  if (!existingUser || !existingUser._id) throw new Error("用户不存在，请先登录");
  await clearStaleActiveMatch(existingUser);
  await assertNoActiveMatch(openid, matchId);

  await db.runTransaction(async (transaction) => {
    result = { code: "ok" };
    const matchRes = await transaction.collection("matches").doc(matchId).get();
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "recruiting") throw new Error("该球局已不在招募中，无法加入");
    if (match.startAt && Number(match.startAt) < Date.now()) {
      throw new Error("该球局开赛时间已过，无法加入");
    }

    const participants = match.participants || [];
    const headcountTarget = match.headcountTarget || 2;
    if (participants.some((p) => p.openid === openid)) {
      result = { code: "already_joined" };
      return;
    }
    if (participants.length >= headcountTarget || (match.headcountJoined ?? participants.length) >= headcountTarget) {
      throw new Error("该球局已满员");
    }

    const user = await getUserInTransaction(transaction, existingUser._id);
    if (!user) throw new Error("用户不存在，请先登录");
    if (user.activeMatchId && user.activeMatchId !== matchId) {
      throw new Error("你已有进行中或招募中的球局，请先处理后再继续");
    }
    const yuedou = Number(user.yuedou) || 0;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法加入约局");

    const addedParticipant = {
      openid,
      userDocId: user._id,
      nickname: user.nickname || "匿名用户",
      avatar: user.avatarUrl || "",
      score: user.score || 0,
      yuedouFrozen: YUEDOU_FROZEN,
      resultChoice: null,
      locationVerified: false,
      locationVerifiedAt: null
    };
    const updatedParticipants = participants.concat(addedParticipant);

    await transaction.collection("matches").doc(matchId).update({
      data: {
        participants: updatedParticipants,
        headcountJoined: updatedParticipants.length
      }
    });
    await transaction.collection("yueqiu8_users").doc(user._id).update({
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN),
        activeMatchId: matchId
      }
    });
    venueId = match.venueId || null;
  });

  if (result.code === "ok" && venueId) {
    try { await recordVenueAccess(openid, venueId, matchId); } catch (e) { console.error("记录球房访问失败", e); }
  }

  return result;
}

// ── 退出球局 ───────────────────────────────────────────────
async function doLeave(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.status !== "recruiting") {
    throw new Error("比赛已开始或已结束，不能退出，请使用关闭异常球局流程");
  }

  const me = (match.participants || []).find((p) => p.openid === openid);
  if (!me) throw new Error("你不在此球局中，无法退出");

  if (match.hostOpenid === openid) {
    const userIdsByOpenid = await getUserIdsByOpenid((match.participants || []).map((p) => p.openid));
    await db.runTransaction(async (transaction) => {
      const latestRes = await transaction.collection("matches").doc(matchId).get();
      const latest = latestRes.data;
      if (!latest) throw new Error("球局不存在");
      if (latest.status !== "recruiting") throw new Error("当前状态不能退出");
      if (latest.hostOpenid !== openid) throw new Error("仅发起人可撤销球局");

      await refundFrozenParticipants(transaction, latest.participants || [], userIdsByOpenid);
      await transaction.collection("matches").doc(matchId).update({
        data: {
          status: "cancelled",
          cancelledAt: db.serverDate(),
          cancelledBy: openid,
          participants: clearParticipantFrozen(latest.participants || [])
        }
      });
    });

    await addNotice({
      type: "match_canceled",
      targetOpenid: openid,
      matchId,
      content: `你发起的球局因你退出已被系统撤销`
    });
    return { code: "canceled_by_host" };
  }

  const existingUser = await getUserByOpenid(openid);
  if (!existingUser || !existingUser._id) throw new Error("用户不存在，请先登录");

  await db.runTransaction(async (transaction) => {
    const latestRes = await transaction.collection("matches").doc(matchId).get();
    const latest = latestRes.data;
    if (!latest) throw new Error("球局不存在");
    if (latest.status !== "recruiting") throw new Error("当前状态不能退出");
    if (latest.hostOpenid === openid) throw new Error("发起人请撤销球局");

    const participants = latest.participants || [];
    const current = participants.find((p) => p.openid === openid);
    if (!current) throw new Error("你不在此球局中，无法退出");
    const frozenAmount = getFrozenAmount(current);
    const updatedParticipants = participants.filter((p) => p.openid !== openid);
    const user = await getUserInTransaction(transaction, current.userDocId || existingUser._id);
    if (!user) throw new Error("用户数据不存在，无法自动退款");
    if ((Number(user.yuedouFrozen) || 0) < frozenAmount) {
      throw new Error("冻结约豆数据异常，无法自动退款");
    }

    await transaction.collection("matches").doc(matchId).update({
      data: {
        participants: updatedParticipants,
        headcountJoined: updatedParticipants.length
      }
    });

    if (frozenAmount > 0) {
      await transaction.collection("yueqiu8_users").doc(user._id).update({
        data: {
          yuedou: _.inc(frozenAmount),
          yuedouFrozen: _.inc(-frozenAmount),
          activeMatchId: null
        }
      });
    } else {
      await transaction.collection("yueqiu8_users").doc(user._id).update({
        data: { activeMatchId: null }
      });
    }
  });

  return { code: "left" };
}

// ── 确认比赛开始 ───────────────────────────────────────────
async function doConfirm(openid, matchId) {
  let allOpenids = [];
  await db.runTransaction(async (transaction) => {
    const matchRes = await transaction.collection("matches").doc(matchId).get();
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.hostOpenid !== openid) throw new Error("仅发起人可确认");
    if (match.status !== "recruiting") throw new Error("当前状态不可确认");

    const participants = match.participants || [];
    const target = match.headcountTarget || 2;
    if (participants.length < target || (match.headcountJoined ?? participants.length) < target) {
      throw new Error("人数未满，不能开始比赛");
    }
    const uniqueOpenids = Array.from(new Set(participants.map((p) => p.openid).filter(Boolean)));
    if (uniqueOpenids.length !== participants.length || !uniqueOpenids.includes(match.hostOpenid)) {
      throw new Error("参与人数据异常，不能开始比赛");
    }

    const allVerified = participants.every((p) => p.locationVerified);
    if (!allVerified) throw new Error("双方需先完成位置校验后才能开始比赛");

    await transaction.collection("matches").doc(matchId).update({
      data: { status: "playing", startedAt: db.serverDate() }
    });
    allOpenids = uniqueOpenids;
  });

  for (const uid of allOpenids) {
    const isHost = uid === openid;
    await recordMatchParticipation(uid, matchId, isHost);
  }

  return { code: "ok" };
}

// ── 提交结果选择 ───────────────────────────────────────────
async function doSubmitResult(openid, matchId, choice) {
  const validChoices = ["win", "lose"];
  if (!validChoices.includes(choice)) throw new Error("无效的选择");

  let outcome = { code: "ok", bothSelected: false };
  let settlement = null;
  const initialMatch = await getMatch(matchId);
  if (!initialMatch) throw new Error("球局不存在");
  const userIdsByOpenid = await getUserIdsByOpenid((initialMatch.participants || []).map((p) => p.openid));

  await db.runTransaction(async (transaction) => {
    outcome = { code: "ok", bothSelected: false };
    settlement = null;

    const matchRes = await transaction.collection("matches").doc(matchId).get();
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "playing") throw new Error("当前状态不能选择结果");
    if ((match.participants || []).length !== 2) throw new Error("仅支持双方满员后结算");

    const participants = match.participants || [];
    const pIdx = participants.findIndex((p) => p.openid === openid);
    if (pIdx < 0) throw new Error("你不在此球局中");

    const updated = participants.map((p) => {
      if (p.openid === openid) return { ...p, resultChoice: choice };
      return p;
    });
    const bothSelected = updated.every((p) => p.resultChoice != null);

    if (!bothSelected) {
      await transaction.collection("matches").doc(matchId).update({
        data: { participants: updated }
      });
      return;
    }

    const choices = {};
    updated.forEach((p) => { choices[p.openid] = p.resultChoice; });
    const host = updated.find((p) => p.openid === match.hostOpenid);
    const joiner = updated.find((p) => p.openid !== match.hostOpenid);
    if (!host || !joiner) throw new Error("参与人数据异常，不能结算");

    const hostChoice = choices[match.hostOpenid] || "";
    const joinChoice = choices[joiner.openid] || "";
    const isConsistent = (hostChoice === "win" && joinChoice === "lose") ||
                         (hostChoice === "lose" && joinChoice === "win");

    if (!isConsistent) {
      await transaction.collection("matches").doc(matchId).update({
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
    const winnerFrozen = getFrozenAmount(winner);
    const loserFrozen = getFrozenAmount(loser);
    if (winnerFrozen <= 0 || loserFrozen <= 0) {
      throw new Error("冻结约豆数据异常，不能自动结算");
    }

    const winnerUser = await getUserInTransaction(transaction, getParticipantUserId(winner, userIdsByOpenid));
    const loserUser = await getUserInTransaction(transaction, getParticipantUserId(loser, userIdsByOpenid));
    if (!winnerUser || !loserUser) throw new Error("用户数据不存在，不能结算");
    if ((Number(winnerUser.yuedouFrozen) || 0) < winnerFrozen ||
        (Number(loserUser.yuedouFrozen) || 0) < loserFrozen) {
      throw new Error("用户冻结约豆数据异常，不能结算");
    }

    await transaction.collection("yueqiu8_users").doc(winnerUser._id).update({
      data: {
        yuedou: _.inc(winnerFrozen + YUEDOU_WINNER),
        yuedouFrozen: _.inc(-winnerFrozen),
        activeMatchId: null
      }
    });
    await transaction.collection("yueqiu8_users").doc(loserUser._id).update({
      data: {
        yuedouFrozen: _.inc(-loserFrozen),
        yuedouSystem: _.inc(YUEDOU_SYSTEM),
        activeMatchId: null
      }
    });

    const finalParticipants = [host, joiner].map((p) => ({
      openid: p.openid,
      nickname: p.nickname,
      resultChoice: p.resultChoice
    }));
    await transaction.collection("matches").doc(matchId).update({
      data: {
        status: "settled",
        settledAt: db.serverDate(),
        finalParticipants,
        participants: clearParticipantFrozen(updated)
      }
    });
    settlement = {
      winnerId,
      loserId,
      venueId: match.venueId || null,
      participants: updated
    };
    outcome = { code: "ok", bothSelected: true };
  });

  if (settlement) {
    await addScoreRecord(settlement.winnerId, "match_win", YUEDOU_WINNER, settlement.venueId, matchId);
    await addScoreRecord(settlement.loserId, "match_lose", 0, settlement.venueId, matchId);

    const winnerNick = settlement.participants.find((p) => p.openid === settlement.winnerId)?.nickname || "某用户";
    const loserNick = settlement.participants.find((p) => p.openid === settlement.loserId)?.nickname || "某用户";
    await addNotice({ type: "match_settled", targetOpenid: settlement.winnerId, matchId, content: `🏆 你赢了「${loserNick}」！获得${YUEDOU_WINNER}约豆，冻结约豆已退回` });
    await addNotice({ type: "match_settled", targetOpenid: settlement.loserId, matchId, content: `😅 你输了「${winnerNick}」，冻结约豆已结算` });

    const openids = Array.from(new Set(settlement.participants.map((p) => p.openid)));
    for (const oid of openids) {
      try { await recordMatchComplete(oid); } catch (_) {}
    }
  }

  return outcome;
}

// ── 关闭/取消球局 ───────────────────────────────────────────
async function cancelMatchWithRefund(matchId, actorOpenid, extraData = {}) {
  let matchForNotice = null;
  const initialMatch = await getMatch(matchId);
  if (!initialMatch) throw new Error("球局不存在");
  const userIdsByOpenid = await getUserIdsByOpenid((initialMatch.participants || []).map((p) => p.openid));

  await db.runTransaction(async (transaction) => {
    const latestRes = await transaction.collection("matches").doc(matchId).get();
    const latest = latestRes.data;
    if (!latest) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(latest.status)) throw new Error("当前状态不可关闭");

    await refundFrozenParticipants(transaction, latest.participants || [], userIdsByOpenid);
    await transaction.collection("matches").doc(matchId).update({
      data: {
        status: "cancelled",
        closedAt: db.serverDate(),
        closedBy: actorOpenid,
        participants: clearParticipantFrozen(latest.participants || []),
        ...extraData
      }
    });
    matchForNotice = latest;
  });

  if (matchForNotice) {
    await addNotice({
      type: matchForNotice.status === "recruiting" ? "match_canceled" : "match_closed",
      targetOpenid: matchForNotice.hostOpenid,
      matchId,
      content: matchForNotice.status === "recruiting"
        ? `你发起的「${matchForNotice.venueName}」球局已关闭，冻结约豆已退回`
        : `「${matchForNotice.venueName}」球局因异常被关闭，冻结约豆已退回`
    });
  }
}

async function doClose(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");

  const isHost = match.hostOpenid === openid;
  const isParticipant = (match.participants || []).some((p) => p.openid === openid);
  if (!isHost && !isParticipant) throw new Error("你无权关闭此球局");

  if (match.status === "recruiting") {
    if (!isHost) throw new Error("仅发起人可关闭招募中的球局");
    if (!match.startAt || Number(match.startAt) > Date.now()) {
      throw new Error("招募中的球局只能在开赛时间过后关闭");
    }
  } else if (match.status === "playing") {
    const startedAt = getTimeMs(match.startedAt);
    if (!startedAt || Date.now() - startedAt <= 6 * 3600000) {
      throw new Error("比赛开始未超过6小时，暂不能强制关闭");
    }
  } else {
    throw new Error("当前状态不可关闭");
  }

  await cancelMatchWithRefund(matchId, openid);
  return { code: "closed" };
}

async function doCancelByVenueOwner(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (!match.venueId) throw new Error("球局缺少球房信息");

  const venueRes = await db.collection("venues").doc(match.venueId).get();
  const venue = venueRes.data;
  if (!venue || venue.ownerOpenid !== openid) throw new Error("你无权取消该球房的球局");
  if (!["recruiting", "playing"].includes(match.status)) throw new Error("当前状态不可取消");

  await cancelMatchWithRefund(matchId, openid, { cancelledByVenueOwner: true });
  return { code: "cancelled" };
}

// ── 位置校验 ───────────────────────────────────────────────
async function doVerifyLocation(openid, matchId, userLat, userLon) {
  const latitude = Number(userLat);
  const longitude = Number(userLon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error("当前位置数据异常，请重新定位");
  }

  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.status !== "recruiting") throw new Error("当前状态无法校验位置");
  if (!match.venueId) throw new Error("球局缺少球房信息，无法校验位置");

  // 球房坐标只能从服务端球房记录读取，不能信任发布者写进球局的数据。
  const venueRecord = await db.collection("venues").doc(match.venueId).get();
  const venueCoordinates = getVenueCoordinates(venueRecord.data);
  if (!venueCoordinates) throw new Error("球房缺少有效位置，无法校验");

  const dist = _calcDistance(
    latitude,
    longitude,
    venueCoordinates.latitude,
    venueCoordinates.longitude
  );
  if (dist > 0.5) {
    return { code: "too_far", verified: false, distance: dist };
  }

  let result = { code: "ok", verified: true, distance: dist };
  await db.runTransaction(async (transaction) => {
    const latestRecord = await transaction.collection("matches").doc(matchId).get();
    const latest = latestRecord.data;
    if (!latest) throw new Error("球局不存在");
    if (latest.status !== "recruiting") throw new Error("当前状态无法校验位置");

    const participants = latest.participants || [];
    const current = participants.find((p) => p.openid === openid);
    if (!current) throw new Error("你不在此球局中");
    if (current.locationVerified) {
      result = { code: "already_verified", verified: true, distance: dist };
      return;
    }

    const updated = participants.map((p) => {
      if (p.openid === openid) {
        return { ...p, locationVerified: true, locationVerifiedAt: Date.now() };
      }
      return p;
    });
    await transaction.collection("matches").doc(matchId).update({
      data: { participants: updated }
    });
  });

  return result;
}

// ── 结算 ───────────────────────────────────────────────────
async function doSettleMatch(matchId, match, participants) {
  let settlement = null;
  const userIdsByOpenid = await getUserIdsByOpenid((participants || match.participants || []).map((p) => p.openid));

  await db.runTransaction(async (transaction) => {
    settlement = null;
    const latestRes = await transaction.collection("matches").doc(matchId).get();
    const latest = latestRes.data;
    if (!latest) throw new Error("球局不存在");
    if (latest.status === "settled") return;
    if (latest.status !== "playing") throw new Error("当前状态不能结算");

    const latestParticipants = latest.participants || participants || [];
    if (latestParticipants.length !== 2) throw new Error("仅支持双方满员后结算");

    const choices = {};
    latestParticipants.forEach((p) => { choices[p.openid] = p.resultChoice; });
    const hostChoice = choices[latest.hostOpenid] || "";
    const joiner = latestParticipants.find((p) => p.openid !== latest.hostOpenid);
    const joinOpenid = joiner && joiner.openid;
    const joinChoice = choices[joinOpenid] || "";

    let winnerId = null;
    let loserId = null;
    if (hostChoice === "win" && joinChoice === "lose") {
      winnerId = latest.hostOpenid;
      loserId = joinOpenid;
    } else if (hostChoice === "lose" && joinChoice === "win") {
      winnerId = joinOpenid;
      loserId = latest.hostOpenid;
    } else {
      throw new Error("双方结果不一致，不能结算");
    }

    const winner = latestParticipants.find((p) => p.openid === winnerId);
    const loser = latestParticipants.find((p) => p.openid === loserId);
    const winnerFrozen = getFrozenAmount(winner);
    const loserFrozen = getFrozenAmount(loser);
    if (winnerFrozen <= 0 || loserFrozen <= 0) {
      throw new Error("冻结约豆数据异常，不能自动结算");
    }

    const winnerUser = await getUserInTransaction(transaction, getParticipantUserId(winner, userIdsByOpenid));
    const loserUser = await getUserInTransaction(transaction, getParticipantUserId(loser, userIdsByOpenid));
    if (!winnerUser || !loserUser) throw new Error("用户数据不存在，不能结算");
    if ((Number(winnerUser.yuedouFrozen) || 0) < winnerFrozen ||
        (Number(loserUser.yuedouFrozen) || 0) < loserFrozen) {
      throw new Error("用户冻结约豆数据异常，不能结算");
    }

    // 赢家拿回自己的冻结额，并获得输家冻结额中的420；输家只消耗已冻结的500。
    await transaction.collection("yueqiu8_users").doc(winnerUser._id).update({
      data: {
        yuedou: _.inc(winnerFrozen + YUEDOU_WINNER),
        yuedouFrozen: _.inc(-winnerFrozen),
        activeMatchId: null
      }
    });
    await transaction.collection("yueqiu8_users").doc(loserUser._id).update({
      data: {
        yuedouFrozen: _.inc(-loserFrozen),
        yuedouSystem: _.inc(YUEDOU_SYSTEM),
        activeMatchId: null
      }
    });

    const orderedFinalParticipants = [
      latestParticipants.find((p) => p.openid === latest.hostOpenid),
      joiner
    ].filter(Boolean);
    const finalParticipants = orderedFinalParticipants.map((p) => ({
      openid: p.openid,
      nickname: p.nickname,
      resultChoice: p.resultChoice
    }));
    await transaction.collection("matches").doc(matchId).update({
      data: {
        status: "settled",
        settledAt: db.serverDate(),
        finalParticipants,
        participants: clearParticipantFrozen(latestParticipants)
      }
    });

    settlement = {
      winnerId,
      loserId,
      venueId: latest.venueId || null,
      participants: latestParticipants
    };
  });

  if (!settlement) return { code: "already_settled" };

  await addScoreRecord(settlement.winnerId, "match_win", YUEDOU_WINNER, settlement.venueId, matchId);
  await addScoreRecord(settlement.loserId, "match_lose", 0, settlement.venueId, matchId);

  const winnerNick = settlement.participants.find((p) => p.openid === settlement.winnerId)?.nickname || "某用户";
  const loserNick = settlement.participants.find((p) => p.openid === settlement.loserId)?.nickname || "某用户";
  await addNotice({ type: "match_settled", targetOpenid: settlement.winnerId, matchId, content: `🏆 你赢了「${loserNick}」！获得${YUEDOU_WINNER}约豆，冻结约豆已退回` });
  await addNotice({ type: "match_settled", targetOpenid: settlement.loserId, matchId, content: `😅 你输了「${winnerNick}」，冻结约豆已结算` });

  const openids = Array.from(new Set(settlement.participants.map((p) => p.openid)));
  for (const oid of openids) {
    try { await recordMatchComplete(oid); } catch (_) {}
  }

  return { code: "settled" };
}

// ── 主入口 ─────────────────────────────────────────────────
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, errMsg: "无法获取用户身份" };
  }

  const { action, matchId, matchData, choice, userLat, userLon } = event;

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
      case "close":
        return { ok: true, ...(await doClose(OPENID, matchId)) };
      case "cancelByVenueOwner":
        return { ok: true, ...(await doCancelByVenueOwner(OPENID, matchId)) };
      case "submitResult":
        return { ok: true, ...(await doSubmitResult(OPENID, matchId, choice)) };
      case "verifyLocation":
        return await doVerifyLocation(OPENID, matchId, userLat, userLon);
      default:
        return { ok: false, errMsg: "未知操作: " + action };
    }
  } catch (e) {
    console.error(`matchService[${action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
