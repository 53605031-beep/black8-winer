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
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_SYSTEM,
  buildSettlementDeltas
} = require("./settlement");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 约豆常量（与 utils/cloudDB.js 保持一致）
const YUEDOU_INITIAL = 10000;

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
    // 发起人：删除球局，退款所有人
    await db.collection("matches").doc(matchId).remove();

    for (const p of match.participants || []) {
      if ((p.yuedouFrozen ?? 0) > 0) {
        try {
          await db.collection("yueqiu8_users").where({ openid: p.openid }).update({
            data: {
              yuedou: _.inc(p.yuedouFrozen),
              yuedouFrozen: _.inc(-p.yuedouFrozen)
            }
          });
        } catch (e) {
          console.error(`退款失败 ${p.openid}`, e);
        }
      }
    }

    await addNotice({
      type: "match_canceled",
      targetOpenid: openid,
      matchId,
      content: `你发起的球局因你退出已被系统撤销`
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

  const allOpenids = [match.hostOpenid, ...(match.participants || []).map((p) => p.openid)];
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
  const choices = {};
  participants.forEach((p) => { choices[p.openid] = p.resultChoice; });

  const hostChoice  = choices[match.hostOpenid] || "";
  const openids     = participants.map((p) => p.openid);
  const joinOpenid  = openids.find((o) => o !== match.hostOpenid);
  const joinChoice  = choices[joinOpenid] || "";
  const venueId     = match.venueId || null;

  // 1. 标记为已结算
  await db.collection("matches").doc(matchId).update({
    data: {
      status: "settled",
      finalParticipants: participants.map((p) => ({
        openid: p.openid,
        nickname: p.nickname,
        resultChoice: p.resultChoice
      }))
    }
  });

  try {
    let winnerId = null, loserId = null;

    if (hostChoice === "win" && joinChoice === "lose") {
      winnerId = match.hostOpenid; loserId = joinOpenid;
    } else if (hostChoice === "lose" && joinChoice === "win") {
      winnerId = joinOpenid; loserId = match.hostOpenid;
    } else {
      // 不可能走到这里（已在 doSubmitResult 拦截），保守处理
      return;
    }

    const winnerFrozen = participants.find((p) => p.openid === winnerId)?.yuedouFrozen;
    const loserFrozen = participants.find((p) => p.openid === loserId)?.yuedouFrozen;
    const deltas = buildSettlementDeltas(winnerFrozen, loserFrozen);

    await db.collection("yueqiu8_users").where({ openid: winnerId }).update({
      data: {
        yuedou: _.inc(deltas.winner.yuedou),
        yuedouFrozen: _.inc(deltas.winner.yuedouFrozen),
        yuedouSystem: _.inc(deltas.winner.yuedouSystem)
      }
    });
    await db.collection("yueqiu8_users").where({ openid: loserId }).update({
      data: {
        yuedou: _.inc(deltas.loser.yuedou),
        yuedouFrozen: _.inc(deltas.loser.yuedouFrozen),
        yuedouSystem: _.inc(deltas.loser.yuedouSystem)
      }
    });

    await addScoreRecord(winnerId, "match_win", 10, venueId, matchId);
    await addScoreRecord(loserId, "match_lose", 0, venueId, matchId);

    const winnerNick = participants.find((p) => p.openid === winnerId)?.nickname || "某用户";
    const loserNick  = participants.find((p) => p.openid === loserId)?.nickname  || "某用户";
    await addNotice({ type: "match_settled", targetOpenid: winnerId, matchId, content: `🏆 你赢了「${loserNick}」！获得+${deltas.winnerReward}约豆，冻结约豆已解冻` });
    await addNotice({ type: "match_settled", targetOpenid: loserId, matchId, content: `😅 你输了「${winnerNick}」，冻结约豆已解冻` });
  } catch (e) {
    console.error("约豆结算异常（需手动补偿）", e);
  }

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
      default:
        return { ok: false, errMsg: "未知操作: " + action };
    }
  } catch (e) {
    console.error(`matchService[${action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
