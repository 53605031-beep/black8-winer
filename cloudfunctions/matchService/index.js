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

function _toTime(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function _uniqueParticipants(participants) {
  const map = new Map();
  (participants || []).forEach((p) => {
    if (!p || !p.openid || map.has(p.openid)) return;
    map.set(p.openid, p);
  });
  return Array.from(map.values());
}

function _participantsWithoutFrozen(participants) {
  return (participants || []).map((p) => ({ ...p, yuedouFrozen: 0 }));
}

async function cancelMatchWithRefund(matchId, openid, reason, assertAllowed) {
  let noticeTargets = [];
  let venueName = "球局";

  await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchRes = await transaction.get(matchRef);
    const match = matchRes.data;
    if (!match) throw new Error("球局不存在");
    if (!["recruiting", "playing"].includes(match.status)) {
      throw new Error("当前状态不可关闭");
    }

    await assertAllowed(transaction, match);

    const participants = _uniqueParticipants(match.participants || []);
    for (const p of participants) {
      const frozen = p.yuedouFrozen ?? 0;
      if (frozen <= 0) continue;

      const userRes = await transaction.get(db.collection("yueqiu8_users").where({ openid: p.openid }));
      const user = userRes.data[0];
      if (!user) continue;

      // 只退本场记录里的冻结额，避免把其他球局的冻结约豆一起解冻。
      const liveFrozen = user.yuedouFrozen || 0;
      const refund = Math.min(frozen, liveFrozen);
      if (refund <= 0) continue;

      await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
        data: {
          yuedou: _.inc(refund),
          yuedouFrozen: _.inc(-refund)
        }
      });
    }

    await transaction.update(matchRef, {
      data: {
        status: "cancelled",
        closedAt: db.serverDate(),
        closedBy: openid,
        closeReason: reason,
        participants: _participantsWithoutFrozen(match.participants || [])
      }
    });

    noticeTargets = participants.map((p) => p.openid);
    venueName = match.venueName || venueName;
  });

  for (const uid of noticeTargets) {
    try {
      await addNotice({
        type: "match_canceled",
        targetOpenid: uid,
        matchId,
        content: `「${venueName}」球局已关闭，已退还本场冻结约豆`
      });
    } catch (e) {
      console.error(`关闭球局通知失败 uid=${uid}`, e);
    }
  }

  return { code: "closed" };
}

// ── 发布球局 ───────────────────────────────────────────────
async function doPublish(openid, matchData) {
  const headcountTarget = matchData.headcountTarget || 2;
  if (headcountTarget < 2) throw new Error("每局至少需要2人");
  if (!matchData.startAt) throw new Error("请选择开局时间");
  if (!matchData.venueId) throw new Error("请选择球房");

  const user = await getUserByOpenid(openid);
  if (!user) throw new Error("用户不存在，请先登录");
  const nickname = user.nickname || "匿名用户";
  const avatar    = user.avatarUrl || "";
  const yuedou    = user.yuedou ?? YUEDOU_INITIAL;

  if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法发起约局");

  // 1. 创建球局
  const matchRes = await db.collection("matches").add({
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

  // 2. 记录球房访问
  if (matchData.venueId) {
    await recordVenueAccess(openid, matchData.venueId, matchRes._id);
  }

  // 3. 冻约豆，失败则删除球局（补偿）
  try {
    await db.collection("yueqiu8_users").where({ openid }).update({
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  } catch (e) {
    await db.collection("matches").doc(matchRes._id).remove();
    throw new Error("冻结约豆失败，约局未发起");
  }

  return { code: "ok" };
}

// ── 加入球局 ───────────────────────────────────────────────
async function doJoin(openid, matchId) {
  const user = await getUserByOpenid(openid);
  if (!user) throw new Error("用户不存在，请先登录");
  const nickname = user.nickname || "匿名用户";
  const score    = user.score || 0;
  const yuedou    = user.yuedou ?? YUEDOU_INITIAL;

  if (yuedou < YUEDOU_FROZEN) throw new Error("约豆不足500，无法加入约局");

  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.status !== "recruiting") throw new Error("该球局已不在招募中，无法加入");
  if ((match.headcountJoined ?? 0) >= (match.headcountTarget || 2)) {
    throw new Error("该球局已满员");
  }

  const participants = match.participants || [];
  if (participants.some((p) => p.openid === openid)) {
    return { code: "already_joined" };
  }

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

  // 1. 加入球局
  await db.collection("matches").doc(matchId).update({
    data: {
      participants: _.push(addedParticipant),
      headcountJoined: _.inc(1)
    }
  });

  // 2. 记录球房访问
  if (match.venueId) {
    await recordVenueAccess(openid, match.venueId, matchId);
  }

  // 3. 冻约豆，失败则退出（补偿）
  try {
    await db.collection("yueqiu8_users").where({ openid }).update({
      data: {
        yuedou: _.inc(-YUEDOU_FROZEN),
        yuedouFrozen: _.inc(YUEDOU_FROZEN)
      }
    });
  } catch (e) {
    await db.collection("matches").doc(matchId).update({
      data: {
        participants: _.pull({ openid }),
        headcountJoined: _.inc(-1)
      }
    });
    throw new Error("冻结约豆失败，未成功加入");
  }

  return { code: "ok" };
}

// ── 退出球局 ───────────────────────────────────────────────
async function doLeave(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");

  const me = (match.participants || []).find((p) => p.openid === openid);
  if (!me) throw new Error("你不在此球局中，无法退出");

  const frozenAmount = me.yuedouFrozen ?? 0;

  // 安全校验：非发起人在进行中/已结算状态不能退出
  if (match.hostOpenid !== openid) {
    if (["playing", "settled", "finished"].includes(match.status)) {
      throw new Error("比赛已开始或已结束，普通参与者不能退出");
    }
  }

  if (match.hostOpenid === openid) {
    if (match.status !== "recruiting") {
      throw new Error("比赛已开始或已结束，发起人不能再退出");
    }

    await cancelMatchWithRefund(matchId, openid, "host_leave", async (transaction, currentMatch) => {
      if (currentMatch.hostOpenid !== openid) throw new Error("仅发起人可关闭招募中的球局");
      if (currentMatch.status !== "recruiting") throw new Error("当前状态不可退出");
    });
    return { code: "canceled_by_host" };
  }

  // 普通参与者：退出球局，再退款
  await db.collection("matches").doc(matchId).update({
    data: {
      participants: _.pull({ openid }),
      headcountJoined: _.inc(-1)
    }
  });

  if (frozenAmount > 0) {
    try {
      await db.collection("yueqiu8_users").where({ openid }).update({
        data: {
          yuedou: _.inc(frozenAmount),
          yuedouFrozen: _.inc(-frozenAmount)
        }
      });
    } catch (e) {
      console.error("退出退款失败（可手动补偿）", e);
    }
  }

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

  const allOpenids = Array.from(new Set([
    match.hostOpenid,
    ...(match.participants || []).map((p) => p.openid)
  ].filter(Boolean)));
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
  let settled = null;

  await db.runTransaction(async (transaction) => {
    const matchRef = db.collection("matches").doc(matchId);
    const matchRes = await transaction.get(matchRef);
    const currentMatch = matchRes.data;
    if (!currentMatch) throw new Error("球局不存在");
    if (currentMatch.status !== "playing") throw new Error("球局已结算或状态已变化");

    const currentParticipants = _uniqueParticipants(currentMatch.participants || participants);
    if (currentParticipants.length !== 2) {
      throw new Error("当前只支持两人球局结算");
    }

    const choices = {};
    currentParticipants.forEach((p) => { choices[p.openid] = p.resultChoice; });

    const hostChoice = choices[currentMatch.hostOpenid] || "";
    const joinOpenid = currentParticipants.map((p) => p.openid).find((o) => o !== currentMatch.hostOpenid);
    const joinChoice = choices[joinOpenid] || "";
    const venueId = currentMatch.venueId || null;

    let winnerId = null;
    let loserId = null;
    if (hostChoice === "win" && joinChoice === "lose") {
      winnerId = currentMatch.hostOpenid;
      loserId = joinOpenid;
    } else if (hostChoice === "lose" && joinChoice === "win") {
      winnerId = joinOpenid;
      loserId = currentMatch.hostOpenid;
    } else {
      throw new Error("双方结果不一致，请重新选择");
    }

    const [winnerRes, loserRes] = await Promise.all([
      transaction.get(db.collection("yueqiu8_users").where({ openid: winnerId })),
      transaction.get(db.collection("yueqiu8_users").where({ openid: loserId }))
    ]);
    const winner = winnerRes.data[0];
    const loser = loserRes.data[0];
    if (!winner || !loser) throw new Error("参赛用户不存在");
    if ((winner.yuedouFrozen || 0) < YUEDOU_FROZEN || (loser.yuedouFrozen || 0) < YUEDOU_FROZEN) {
      throw new Error("冻结约豆异常，无法自动结算");
    }

    await transaction.update(db.collection("yueqiu8_users").doc(winner._id), {
      data: {
        yuedou: _.inc(YUEDOU_FROZEN + YUEDOU_WINNER),
        yuedouFrozen: _.inc(-YUEDOU_FROZEN)
      }
    });
    await transaction.update(db.collection("yueqiu8_users").doc(loser._id), {
      data: {
        yuedouFrozen: _.inc(-YUEDOU_FROZEN),
        yuedouSystem: _.inc(YUEDOU_SYSTEM)
      }
    });

    await transaction.update(matchRef, {
      data: {
        status: "settled",
        participants: _participantsWithoutFrozen(currentParticipants),
        finalParticipants: currentParticipants.map((p) => ({
          openid: p.openid,
          nickname: p.nickname,
          resultChoice: p.resultChoice
        }))
      }
    });

    await transaction.add(db.collection("score_records"), {
      data: {
        userId: winnerId,
        type: "match_win",
        amount: YUEDOU_WINNER,
        venueId,
        matchId,
        createdAt: db.serverDate()
      }
    });
    await transaction.add(db.collection("score_records"), {
      data: {
        userId: loserId,
        type: "match_lose",
        amount: YUEDOU_LOSER,
        venueId,
        matchId,
        createdAt: db.serverDate()
      }
    });

    settled = {
      winnerId,
      loserId,
      openids: currentParticipants.map((p) => p.openid),
      winnerNick: currentParticipants.find((p) => p.openid === winnerId)?.nickname || "某用户",
      loserNick: currentParticipants.find((p) => p.openid === loserId)?.nickname || "某用户"
    };
  });

  await addNotice({ type: "match_settled", targetOpenid: settled.winnerId, matchId, content: `🏆 你赢了「${settled.loserNick}」！获得+${YUEDOU_WINNER}约豆，冻结约豆已解冻` });
  await addNotice({ type: "match_settled", targetOpenid: settled.loserId, matchId, content: `😅 你输了「${settled.winnerNick}」，本场冻结约豆已扣除` });

  // 完成比赛积分只按去重后的参赛人记录一次。
  for (const oid of Array.from(new Set(settled.openids))) {
    try { await recordMatchComplete(oid); } catch (_) {}
  }
}

async function doCloseMatch(openid, matchId) {
  return cancelMatchWithRefund(matchId, openid, "manual_close", async (transaction, match) => {
    const isHost = match.hostOpenid === openid;
    const isParticipant = (match.participants || []).some((p) => p.openid === openid);
    if (!isHost && !isParticipant) throw new Error("你无权关闭此球局");

    if (match.status === "recruiting") {
      if (!isHost) throw new Error("仅发起人可关闭招募中的球局");
      if (!match.startAt || _toTime(match.startAt) >= Date.now()) {
        throw new Error("开赛时间未过，暂不能关闭");
      }
    }

    if (match.status === "playing") {
      const startedAt = _toTime(match.startedAt);
      if (startedAt && Date.now() - startedAt <= 6 * 60 * 60 * 1000) {
        throw new Error("比赛开始未超过6小时，暂不能关闭");
      }
    }
  });
}

async function doCancelByVenueOwner(openid, matchId) {
  return cancelMatchWithRefund(matchId, openid, "venue_owner_cancel", async (transaction, match) => {
    if (!match.venueId) throw new Error("球局缺少球房信息");
    const venueRes = await transaction.get(db.collection("venues").doc(match.venueId));
    const venue = venueRes.data;
    if (!venue || venue.ownerOpenid !== openid) {
      throw new Error("只有球房商家可以取消本店球局");
    }
  });
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
        return { ok: true, ...(await doCloseMatch(OPENID, matchId)) };
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
