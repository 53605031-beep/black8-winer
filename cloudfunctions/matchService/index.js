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
    const nextParticipants = participants.concat(addedParticipant);
    venueId = match.venueId || null;

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

  if (code === "ok" && venueId) {
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
  let code = "left";
  let hostOpenid = "";
  let status = "";

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");

    const participants = match.participants || [];
    const me = participants.find((p) => p.openid === openid);
    if (!me) throw new Error("你不在此球局中，无法退出");

    hostOpenid = match.hostOpenid;
    status = match.status;
    const isHost = match.hostOpenid === openid;

    if (["playing", "settled", "finished"].includes(match.status)) {
      throw new Error(isHost ? "比赛已开始，发起人不能撤销球局" : "比赛已开始或已结束，普通参与者不能退出");
    }
    if (match.status !== "recruiting") throw new Error("当前状态不能退出");

    if (isHost) {
      const refundedParticipants = participants.map((p) => ({ ...p, yuedouFrozen: 0 }));
      for (const p of participants) {
        const frozenAmount = p.yuedouFrozen ?? 0;
        if (frozenAmount > 0) {
          await transaction.update(db.collection("yueqiu8_users").where({ openid: p.openid }), {
            data: {
              yuedou: _.inc(frozenAmount),
              yuedouFrozen: _.inc(-frozenAmount)
            }
          });
        }
      }
      await transaction.update(db.collection("matches").doc(matchId), {
        data: {
          status: "cancelled",
          participants: refundedParticipants,
          cancelledAt: db.serverDate(),
          cancelledBy: openid,
          cancelReason: "发起人退出"
        }
      });
      code = "canceled_by_host";
      return;
    }

    const frozenAmount = me.yuedouFrozen ?? 0;
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

  if (code === "canceled_by_host") {
    await addNotice({
      type: "match_canceled",
      targetOpenid: hostOpenid || openid,
      matchId,
      content: status === "recruiting" ? "你发起的球局因你退出已被系统撤销" : "球局已撤销"
    });
  }

  return { code };
}

// ── 关闭异常/过期球局 ───────────────────────────────────────
async function doClose(openid, matchId) {
  let targetOpenids = [];
  let status = "";
  let hostOpenid = "";

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

    status = match.status;
    hostOpenid = match.hostOpenid;

    const refundedParticipants = [];
    const seen = {};
    for (const p of participants) {
      const frozenAmount = p.yuedouFrozen ?? 0;
      refundedParticipants.push({ ...p, yuedouFrozen: 0 });
      if (seen[p.openid]) continue;
      seen[p.openid] = true;
      targetOpenids.push(p.openid);
      if (frozenAmount > 0) {
        await transaction.update(db.collection("yueqiu8_users").where({ openid: p.openid }), {
          data: {
            yuedou: _.inc(frozenAmount),
            yuedouFrozen: _.inc(-frozenAmount)
          }
        });
      }
    }

    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "cancelled",
        participants: refundedParticipants,
        closedAt: db.serverDate(),
        closedBy: openid
      }
    });
  });

  await addNotice({
    type: status === "recruiting" ? "match_canceled" : "match_closed",
    targetOpenid: hostOpenid || openid,
    matchId,
    content: status === "recruiting"
      ? "你发起的球局已关闭，冻结约豆已退回"
      : "球局已关闭，参与者冻结约豆已退回"
  });

  return { code: "closed", refundedCount: targetOpenids.length };
}

// ── 确认比赛开始 ───────────────────────────────────────────
async function doConfirm(openid, matchId) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("球局不存在");
  if (match.hostOpenid !== openid) throw new Error("仅发起人可确认");
  if (match.status !== "recruiting") throw new Error("当前状态不可确认");

  const participants = match.participants || [];
  const headcountTarget = match.headcountTarget || 2;
  if (participants.length < 2 || participants.length < headcountTarget) {
    throw new Error("球局人数未满，不能开始比赛");
  }

  const allVerified = participants.every((p) => p.locationVerified);
  if (!allVerified) throw new Error("双方需先完成位置校验后才能开始比赛");

  await db.collection("matches").doc(matchId).update({
    data: { status: "playing", startedAt: db.serverDate() }
  });

  const allOpenids = Array.from(new Set([match.hostOpenid, ...participants.map((p) => p.openid)]));
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

  let response = { code: "ok", bothSelected: false };
  let settledInfo = null;

  await db.runTransaction(async (transaction) => {
    const matchRecord = await transaction.get(db.collection("matches").doc(matchId));
    const match = matchRecord.data;
    if (!match) throw new Error("球局不存在");
    if (match.status !== "playing") throw new Error("当前状态不能选择结果");

    const participants = match.participants || [];
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
      response = { code: "ok", bothSelected: false };
      return;
    }

    const hostParticipant = updated.find((p) => p.openid === match.hostOpenid);
    const joinParticipant = updated.find((p) => p.openid !== match.hostOpenid);
    if (!hostParticipant || !joinParticipant) throw new Error("结算参与人异常");

    const hostChoice = hostParticipant.resultChoice;
    const joinChoice = joinParticipant.resultChoice;
    const isConsistent = (hostChoice === "win" && joinChoice === "lose") ||
                         (hostChoice === "lose" && joinChoice === "win");

    if (!isConsistent) {
      await transaction.update(db.collection("matches").doc(matchId), {
        data: {
          participants: updated.map((p) => ({ ...p, resultChoice: null })),
          conflictAt: db.serverDate()
        }
      });
      response = { code: "conflict", bothSelected: false };
      return;
    }

    const winner = hostChoice === "win" ? hostParticipant : joinParticipant;
    const loser = hostChoice === "win" ? joinParticipant : hostParticipant;
    const winnerFrozen = winner.yuedouFrozen ?? YUEDOU_FROZEN;
    const loserFrozen = loser.yuedouFrozen ?? YUEDOU_FROZEN;
    const settledParticipants = updated.map((p) => ({ ...p, yuedouFrozen: 0 }));

    await transaction.update(db.collection("matches").doc(matchId), {
      data: {
        status: "settled",
        participants: settledParticipants,
        finalParticipants: updated.map((p) => ({
          openid: p.openid,
          nickname: p.nickname,
          resultChoice: p.resultChoice
        })),
        settledAt: db.serverDate()
      }
    });

    await transaction.update(db.collection("yueqiu8_users").where({ openid: winner.openid }), {
      data: {
        yuedou: _.inc(winnerFrozen + YUEDOU_WINNER),
        yuedouFrozen: _.inc(-winnerFrozen),
        totalWin: _.inc(1)
      }
    });
    await transaction.update(db.collection("yueqiu8_users").where({ openid: loser.openid }), {
      data: {
        yuedouFrozen: _.inc(-loserFrozen),
        yuedouSystem: _.inc(YUEDOU_SYSTEM),
        totalLose: _.inc(1)
      }
    });

    await transaction.add(db.collection("score_records"), {
      data: {
        userId: winner.openid,
        type: "match_win",
        amount: YUEDOU_WINNER,
        venueId: match.venueId || null,
        matchId,
        createdAt: db.serverDate()
      }
    });
    await transaction.add(db.collection("score_records"), {
      data: {
        userId: loser.openid,
        type: "match_lose",
        amount: -loserFrozen,
        venueId: match.venueId || null,
        matchId,
        createdAt: db.serverDate()
      }
    });

    settledInfo = {
      openids: Array.from(new Set(updated.map((p) => p.openid))),
      winner,
      loser
    };
    response = { code: "ok", bothSelected: true };
  });

  if (settledInfo) {
    await addNotice({
      type: "match_settled",
      targetOpenid: settledInfo.winner.openid,
      matchId,
      content: `🏆 你赢了「${settledInfo.loser.nickname || "某用户"}」！获得+${YUEDOU_WINNER}约豆，冻结约豆已解冻`
    });
    await addNotice({
      type: "match_settled",
      targetOpenid: settledInfo.loser.openid,
      matchId,
      content: `😅 你输了「${settledInfo.winner.nickname || "某用户"}」，冻结约豆已扣除`
    });

    for (const oid of settledInfo.openids) {
      try { await recordMatchComplete(oid); } catch (_) {}
    }
  }

  return response;
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
  throw new Error("请通过 doSubmitResult 的事务流程结算球局");
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
