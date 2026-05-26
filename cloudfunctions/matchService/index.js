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
 *   cancelByVenueOwner 商家取消本球房球局并退回本局冻结约豆
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

function _sameOpenidList(a, b) {
  const left = (a || []).map((p) => p.openid).sort();
  const right = (b || []).map((p) => p.openid).sort();
  return left.length === right.length && left.every((id, idx) => id === right[idx]);
}

function _sumFrozenByOpenid(participants) {
  return (participants || []).reduce((map, p) => {
    if (!p.openid) return map;
    const amount = p.yuedouFrozen ?? 0;
    map[p.openid] = (map[p.openid] || 0) + amount;
    return map;
  }, {});
}

async function getUserDocsByOpenids(openids) {
  const docs = {};
  for (const openid of openids) {
    const user = await getUserByOpenid(openid);
    if (user && user._id) docs[openid] = user;
  }
  return docs;
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

async function cancelMatchAndRefund(matchId, actorOpenid, options = {}) {
  const before = await getMatch(matchId);
  if (!before) throw new Error("球局不存在");
  if (!["recruiting", "playing"].includes(before.status)) throw new Error("当前状态不可关闭");
  if (options.validate) options.validate(before);

  const frozenByOpenid = _sumFrozenByOpenid(before.participants || []);
  const userDocs = await getUserDocsByOpenids(Object.keys(frozenByOpenid));
  for (const uid of Object.keys(frozenByOpenid)) {
    if ((frozenByOpenid[uid] || 0) > 0 && !userDocs[uid]) {
      throw new Error("退款用户不存在，请重试");
    }
  }

  await db.runTransaction(async (transaction) => {
    const latestRes = await transaction.collection("matches").doc(matchId).get();
    const latest = latestRes.data;
    if (!latest) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(latest.status)) throw new Error("当前状态不可关闭");
    if (!_sameOpenidList(before.participants || [], latest.participants || [])) {
      throw new Error("球局参与人已变化，请重试");
    }
    if (options.validate) options.validate(latest);

    const latestFrozen = _sumFrozenByOpenid(latest.participants || []);
    for (const uid of Object.keys(latestFrozen)) {
      const amount = latestFrozen[uid] || 0;
      const user = userDocs[uid];
      if (amount > 0 && user && user._id) {
        await transaction.collection("yueqiu8_users").doc(user._id).update({
          data: {
            yuedou: _.inc(amount),
            yuedouFrozen: _.inc(-amount)
          }
        });
      }
    }

    await transaction.collection("matches").doc(matchId).update({
      data: {
        status: "cancelled",
        closedAt: db.serverDate(),
        closedBy: actorOpenid,
        closeReason: options.reason || "closed",
        participants: (latest.participants || []).map((p) => ({ ...p, yuedouFrozen: 0 }))
      }
    });
  });

  return { code: "cancelled" };
}

// ── 发布球局 ───────────────────────────────────────────────
async function doPublish(openid, matchData) {
  const headcountTarget = matchData.headcountTarget || 2;
  if (headcountTarget < 2) throw new Error("每局至少需要2人");
  if (headcountTarget !== 2) throw new Error("当前版本仅支持双人球局");
  if (!matchData.startAt) throw new Error("请选择开局时间");
  if (!matchData.venueId) throw new Error("请选择球房");

  const user = await getUserByOpenid(openid);
  if (!user) throw new Error("用户不存在，请先登录");
  const nickname = user.nickname || "匿名用户";
  const avatar    = user.avatarUrl || "";

  let matchId = null;
  await db.runTransaction(async (transaction) => {
    const latestUserRes = await transaction.collection("yueqiu8_users").doc(user._id).get();
    const latestUser = latestUserRes.data || {};
    const yuedou = latestUser.yuedou ?? YUEDOU_INITIAL;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法发起约局");

    const matchRes = await transaction.collection("matches").add({
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

    await transaction.collection("yueqiu8_users").doc(user._id).update({
      data: {
        yuedou: yuedou - YUEDOU_FROZEN,
        yuedouFrozen: (latestUser.yuedouFrozen || 0) + YUEDOU_FROZEN
      }
    });
  });

  // 记录球房访问失败不影响已创建的球局和冻结状态
  if (matchData.venueId) {
    try {
      await recordVenueAccess(openid, matchData.venueId, matchId);
    } catch (err) {
      console.error("记录球房访问失败", err);
    }
  }

  return { code: "ok", matchId };
}

// ── 加入球局 ───────────────────────────────────────────────
async function doJoin(openid, matchId) {
  const user = await getUserByOpenid(openid);
  if (!user) throw new Error("用户不存在，请先登录");
  const nickname = user.nickname || "匿名用户";
  const score    = user.score || 0;

  const addedParticipant = {
    openid,
    nickname,
    avatar: user.avatarUrl || "",
    score,
    yuedouFrozen: YUEDOU_FROZEN,
    resultChoice: null,
    locationVerified: false,
    locationVerifiedAt: null
  };

  let result = { code: "ok" };
  let venueId = null;
  await db.runTransaction(async (transaction) => {
    const latestUserRes = await transaction.collection("yueqiu8_users").doc(user._id).get();
    const latestMatchRes = await transaction.collection("matches").doc(matchId).get();
    const latestUser = latestUserRes.data || {};
    const match = latestMatchRes.data;
    if (!match) throw new Error("球局不存在");

    const yuedou = latestUser.yuedou ?? YUEDOU_INITIAL;
    if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法加入约局");
    if (match.status !== "recruiting") throw new Error("该球局已不在招募中，无法加入");

    const participants = match.participants || [];
    if (participants.some((p) => p.openid === openid)) {
      result = { code: "already_joined" };
      return;
    }
    if (participants.length >= (match.headcountTarget || 2)) {
      throw new Error("该球局已满员");
    }

    venueId = match.venueId || null;
    await transaction.collection("matches").doc(matchId).update({
      data: {
        participants: [...participants, addedParticipant],
        headcountJoined: participants.length + 1
      }
    });
    await transaction.collection("yueqiu8_users").doc(user._id).update({
      data: {
        yuedou: yuedou - YUEDOU_FROZEN,
        yuedouFrozen: (latestUser.yuedouFrozen || 0) + YUEDOU_FROZEN
      }
    });
  });

  if (result.code === "ok" && venueId) {
    try {
      await recordVenueAccess(openid, venueId, matchId);
    } catch (err) {
      console.error("记录球房访问失败", err);
    }
  }

  return result;
}

// ── 退出球局 ───────────────────────────────────────────────
async function doLeave(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");

  const me = (match.participants || []).find((p) => p.openid === openid);
  if (!me) throw new Error("你不在此球局中，无法退出");

  // 安全校验：非发起人在进行中/已结算状态不能退出
  if (match.hostOpenid !== openid) {
    if (["playing", "settled", "finished"].includes(match.status)) {
      throw new Error("比赛已开始或已结束，普通参与者不能退出");
    }
  }

  if (match.hostOpenid === openid) {
    if (match.status !== "recruiting") {
      throw new Error("比赛已开始，发起人不能撤销球局");
    }
    await cancelMatchAndRefund(matchId, openid, {
      reason: "host_leave",
      validate: (current) => {
        if (current.hostOpenid !== openid) throw new Error("仅发起人可撤销球局");
        if (current.status !== "recruiting") throw new Error("当前状态不可撤销");
      }
    });

    await addNotice({
      type: "match_canceled",
      targetOpenid: openid,
      matchId,
      content: `你发起的球局因你退出已被系统撤销`
    });
    return { code: "canceled_by_host" };
  }

  const user = await getUserByOpenid(openid);
  if (!user || !user._id) throw new Error("用户不存在，请先登录");

  // 普通参与者：退出和本局退款必须一起成功，避免列表已退出但约豆仍被冻结
  await db.runTransaction(async (transaction) => {
    const latestMatchRes = await transaction.collection("matches").doc(matchId).get();
    const latestMatch = latestMatchRes.data;
    if (!latestMatch) throw new Error("球局不存在");
    if (["playing", "settled", "finished"].includes(latestMatch.status)) {
      throw new Error("比赛已开始或已结束，普通参与者不能退出");
    }
    const latestParticipants = latestMatch.participants || [];
    const latestMe = latestParticipants.find((p) => p.openid === openid);
    if (!latestMe) throw new Error("你不在此球局中，无法退出");
    const frozenAmount = latestMe.yuedouFrozen ?? 0;

    await transaction.collection("matches").doc(matchId).update({
      data: {
        participants: latestParticipants.filter((p) => p.openid !== openid),
        headcountJoined: Math.max(0, latestParticipants.length - 1)
      }
    });

    if (frozenAmount > 0) {
      await transaction.collection("yueqiu8_users").doc(user._id).update({
        data: {
          yuedou: _.inc(frozenAmount),
          yuedouFrozen: _.inc(-frozenAmount)
        }
      });
    }
  });

  return { code: "left" };
}

// ── 确认比赛开始 ───────────────────────────────────────────
async function doConfirm(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.hostOpenid !== openid) throw new Error("仅发起人可确认");
  if (match.status !== "recruiting") throw new Error("当前状态不可确认");

  const allVerified = (match.participants || []).every((p) => p.locationVerified);
  if (!allVerified) throw new Error("双方需先完成位置校验后才能开始比赛");

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
    const hostChoice = updated.find((p) => p.openid === match.hostOpenid)?.resultChoice;
    const joinChoice = updated.find((p) => p.openid !== match.hostOpenid)?.resultChoice;
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

async function doClose(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");

  const isHost = match.hostOpenid === openid;
  const isParticipant = (match.participants || []).some((p) => p.openid === openid);
  if (!isHost && !isParticipant) throw new Error("你无权关闭此球局");
  if (match.status === "recruiting" && !isHost) throw new Error("仅发起人可关闭招募中的球局");

  await cancelMatchAndRefund(matchId, openid, {
    reason: match.status === "recruiting" ? "host_close" : "timeout_close",
    validate: (current) => {
      const currentHost = current.hostOpenid === openid;
      const currentParticipant = (current.participants || []).some((p) => p.openid === openid);
      if (!currentHost && !currentParticipant) throw new Error("你无权关闭此球局");
      if (current.status === "recruiting" && !currentHost) throw new Error("仅发起人可关闭招募中的球局");
    }
  });

  await addNotice({
    type: match.status === "recruiting" ? "match_canceled" : "match_closed",
    targetOpenid: match.hostOpenid,
    matchId,
    content: match.status === "recruiting"
      ? `你发起的「${match.venueName}」球局已关闭，冻结约豆已退回`
      : `「${match.venueName}」球局因超时被关闭，冻结约豆已退回`
  });

  return { code: "cancelled" };
}

async function doCancelByVenueOwner(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (!match.venueId) throw new Error("球局缺少球房信息");
  const venue = await db.collection("venues").doc(match.venueId).get();
  if (!venue.data || venue.data.ownerOpenid !== openid) throw new Error("你无权取消该球局");

  await cancelMatchAndRefund(matchId, openid, {
    reason: "venue_owner_cancel",
    validate: (current) => {
      if (current.venueId !== match.venueId) throw new Error("球局所属球房已变化，请重试");
    }
  });

  for (const p of match.participants || []) {
    await addNotice({
      type: "match_canceled",
      targetOpenid: p.openid,
      matchId,
      content: `商家已取消「${match.venueName}」球局，冻结约豆已退回`,
      venueId: match.venueId || null
    });
  }

  return { code: "cancelled" };
}

// ── 结算 ───────────────────────────────────────────────────
async function doSettleMatch(matchId, match, participants) {
  if ((participants || []).length !== 2) {
    throw new Error("当前版本仅支持双人球局结算，请联系客服处理");
  }

  const choices = {};
  participants.forEach((p) => { choices[p.openid] = p.resultChoice; });

  const hostChoice  = choices[match.hostOpenid] || "";
  const openids     = participants.map((p) => p.openid);
  const joinOpenid  = openids.find((o) => o !== match.hostOpenid);
  const joinChoice  = choices[joinOpenid] || "";
  const venueId     = match.venueId || null;

  let winnerId = null, loserId = null;
  if (hostChoice === "win" && joinChoice === "lose") {
    winnerId = match.hostOpenid; loserId = joinOpenid;
  } else if (hostChoice === "lose" && joinChoice === "win") {
    winnerId = joinOpenid; loserId = match.hostOpenid;
  } else {
    throw new Error("比赛结果不一致，请重新提交");
  }

  const userDocs = await getUserDocsByOpenids([winnerId, loserId]);
  if (!userDocs[winnerId] || !userDocs[loserId]) throw new Error("结算用户不存在");

  const winner = participants.find((p) => p.openid === winnerId);
  const loser = participants.find((p) => p.openid === loserId);
  const winnerFrozen = winner?.yuedouFrozen ?? 0;
  const loserFrozen = loser?.yuedouFrozen ?? 0;
  const loserStake = Math.abs(YUEDOU_LOSER);
  const loserDirectDebit = Math.max(0, loserStake - loserFrozen);
  const loserRefund = Math.max(0, loserFrozen - loserStake);

  await db.runTransaction(async (transaction) => {
    const latestMatchRes = await transaction.collection("matches").doc(matchId).get();
    const latestMatch = latestMatchRes.data;
    if (!latestMatch) throw new Error("球局不存在");
    if (latestMatch.status !== "playing") throw new Error("当前状态不能结算");
    if (!_sameOpenidList(participants, latestMatch.participants || [])) {
      throw new Error("球局参与人已变化，请重试");
    }

    await transaction.collection("yueqiu8_users").doc(userDocs[winnerId]._id).update({
      data: {
        yuedou: _.inc(winnerFrozen + YUEDOU_WINNER),
        yuedouFrozen: _.inc(-winnerFrozen)
      }
    });
    await transaction.collection("yueqiu8_users").doc(userDocs[loserId]._id).update({
      data: {
        yuedou: _.inc(loserRefund - loserDirectDebit),
        yuedouFrozen: _.inc(-loserFrozen),
        yuedouSystem: _.inc(YUEDOU_SYSTEM)
      }
    });

    await transaction.collection("matches").doc(matchId).update({
      data: {
        status: "settled",
        finalParticipants: participants.map((p) => ({
          openid: p.openid,
          nickname: p.nickname,
          resultChoice: p.resultChoice,
          yuedouFrozen: 0
        })),
        participants: participants.map((p) => ({ ...p, yuedouFrozen: 0 }))
      }
    });
  });

  await addScoreRecord(winnerId, "match_win", YUEDOU_WINNER, venueId, matchId);
  await addScoreRecord(loserId, "match_lose", -Math.abs(YUEDOU_LOSER), venueId, matchId);

  const winnerNick = participants.find((p) => p.openid === winnerId)?.nickname || "某用户";
  const loserNick  = participants.find((p) => p.openid === loserId)?.nickname  || "某用户";
  await addNotice({ type: "match_settled", targetOpenid: winnerId, matchId, content: `🏆 你赢了「${loserNick}」！获得+${YUEDOU_WINNER}约豆，冻结约豆已解冻` });
  await addNotice({ type: "match_settled", targetOpenid: loserId, matchId, content: `😅 你输了「${winnerNick}」，冻结约豆已解冻` });

  // 2. 完成比赛积分
  for (const oid of openids) {
    try { await recordMatchComplete(oid); } catch (_) {}
  }
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
