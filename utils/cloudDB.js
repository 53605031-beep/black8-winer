/**
 * 约球8 · 云数据库操作层
 *
 * 集合说明：
 *   venues     - 球房表
 *   matches    - 球局表
 *   yueqiu8_users - 用户表（独立于老项目，避免数据冲突）
 *   notices    - 通知表
 *   mall_goods - 积分商城商品
 *   mall_redemptions - 兑换记录
 *
 * 每个集合均需在云开发控制台提前创建并配置权限。
 */

// 懒加载：不在模块加载时初始化 cloudDB，等 app.js 中 wx.cloud.init() 执行完毕后再调用
let _DB = null;
function DB() {
  if (!_DB) _DB = wx.cloud.database();
  return _DB;
}

/* ─────────────────────────────── merchant_applications ─────────────────────────────── */

/**
 * 提交商家入驻申请（同时在 venues 表创建草稿记录）
 * @param {object} data { name, address, phone, openHours, tags, latitude, longitude }
 */
async function submitMerchantApplication(data) {
  const openid = getOpenid();
  const user = await DB().collection("yueqiu8_users").where({ openid }).get();
  const nickname = user.data[0]?.nickname || "匿名用户";

  const db = DB();
  const venueData = {
    name: data.name,
    address: data.address,
    phone: data.phone,
    openHours: data.openHours,
    tags: data.tags || [],
    ownerOpenid: openid,
    ownerNickname: nickname,
    status: "pending",  // 草稿状态，等待审批
    createdAt: db.serverDate()
  };
  if (data.latitude != null && data.longitude != null) {
    venueData.location = new db.Geo.Point(data.longitude, data.latitude);
  }

  // 先创建 venues 草稿记录（集合不存在或无权限时会报错，提前给出明确提示）
  const venueResult = await db.collection("venues").add({ data: venueData });
  if (!venueResult || !venueResult._id) {
    throw new Error("venues 集合写入失败，请确认该集合已在云开发控制台创建并配置了写入权限。");
  }
  const venueId = venueResult._id;

  // 再创建申请记录
  await db.collection("merchant_applications").add({
    data: {
      applicantOpenid: openid,
      applicantNickname: nickname,
      venueName: data.name,
      venueAddress: data.address,
      venuePhone: data.phone,
      venueOpenHours: data.openHours,
      venueTags: data.tags || [],
      latitude: data.latitude,
      longitude: data.longitude,
      venueId: venueId,  // 关联 venues 记录
      status: "pending",
      rejectReason: "",
      createdAt: db.serverDate(),
      processedAt: null
    }
  });

  return { venueId };
}

/**
 * 获取我的入驻申请（有则只返回一条最新记录）
 */
async function getMyMerchantApplication() {
  const openid = getOpenid();
  const { data } = await DB().collection("merchant_applications")
    .where({ applicantOpenid: openid })
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  return data[0] || null;
}

/**
 * 获取商家申请列表（管理员用）
 * @param {string|null} status  "pending" | "approved" | "rejected" | null（全部）
 */
async function getMerchantApplications(status) {
  const where = {};
  if (status) where.status = status;
  const { data } = await DB().collection("merchant_applications")
    .where(where)
    .orderBy("createdAt", "desc")
    .get();
  return data;
}

/**
 * 管理员：通过申请（走云函数写库）
 * venues 在客户端权限为「仅创建者可读写」时，管理员无法直接 update，必须在云函数内操作数据库。
 * @param {string} appId  merchant_applications 记录 id
 */
async function approveMerchantApplication(appId) {
  const res = await wx.cloud.callFunction({
    name: "adminMerchant",
    data: { action: "approve", appId }
  });
  const out = res.result || {};
  if (!out.ok) {
    throw new Error(out.errMsg || "审批失败");
  }
  return out.venueId;
}

/**
 * 管理员：拒绝申请（走云函数写库，原因同上）
 * @param {string} appId
 * @param {string} reason  拒绝原因
 */
async function rejectMerchantApplication(appId, reason) {
  const res = await wx.cloud.callFunction({
    name: "adminMerchant",
    data: { action: "reject", appId, reason }
  });
  const out = res.result || {};
  if (!out.ok) {
    throw new Error(out.errMsg || "拒绝失败");
  }
}

/* ─────────────────────────────── venues ─────────────────────────────── */

/**
 * 获取附近球房列表
 * @param {object} location  { latitude, longitude }
 * @returns {Promise<Array>}
 */
async function getVenues(location) {
  const { latitude, longitude } = location || {};
  const { data } = await DB().collection("venues")
    .where({ status: "active" })
    .orderBy("createdAt", "desc")
    .get();

  if (!latitude || !longitude) {
    // 无用户位置时，仍规范化 location 为 {latitude, longitude} 格式
    return data.map((v) => {
      v.location = {
        latitude: v._locationPlain?.latitude ?? v.location?.coordinates?.[1] ?? v.latitude,
        longitude: v._locationPlain?.longitude ?? v.location?.coordinates?.[0] ?? v.longitude
      };
      return v;
    });
  }

  // 计算每条记录的直线距离（km）
  return data.map((v) => {
    // 优先使用 _locationPlain，其次从 location Geo.Point 解析，最后兜底 latitude/longitude
    let lat = v._locationPlain?.latitude ?? v.location?.coordinates?.[1] ?? v.latitude;
    let lon = v._locationPlain?.longitude ?? v.location?.coordinates?.[0] ?? v.longitude;

    if (lat != null && lon != null) {
      v.distanceKm = _calcDistance(latitude, longitude, lat, lon);
    } else {
      v.distanceKm = null;
    }
    return v;
  }).sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
}

/**
 * 添加球房（商家入驻）
 * @param {object} venueData { name, address, phone, openHours, tags, latitude, longitude }
 */
async function addVenue(venueData) {
  const { latitude, longitude, ...rest } = venueData;
  const data = {
    ...rest,
    status: "active",
    createdAt: DB().serverDate()
  };
  if (latitude != null && longitude != null) {
    data.location = new DB().Geo.Point(longitude, latitude);
    data._locationPlain = { latitude, longitude }; // 普通对象，供前端直接使用
  }
  return DB().collection("venues").add({ data });
}

/**
 * 根据 ID 获取球房
 */
async function getVenueById(venueId) {
  // .doc().get() 返回文档对象，不是 { data: [...] }
  const res = await DB().collection("venues").doc(venueId).get();
  return res.data || null;
}

/**
 * 获取所有商户（管理员用，包含所有状态）
 */
async function getAllVenues() {
  const { data } = await DB().collection("venues")
    .orderBy("createdAt", "desc")
    .get();
  return data;
}

/**
 * 删除商户（管理员用）
 * @param {string} venueId
 */
async function deleteVenue(venueId) {
  return DB().collection("venues").doc(venueId).remove();
}

/* ─────────────────────────────── matches ─────────────────────────────── */

// 约豆结算常量（全局共享）
const YUEDOU_FROZEN      = 500;   // 加入时冻结
const YUEDOU_LOSER       = 500;   // 输者扣：赢家+420，系统+80
const YUEDOU_WINNER      = 420;
const YUEDOU_SYSTEM      = 80;
const YUEDOU_INITIAL     = 10000;  // 新用户注册赠送
const YUEDOU_DAILY_BONUS = 1000;  // 每日礼包每次领取额度
const YUEDOU_DAILY_POOL  = 50000; // 每日总资金池（够50人）

/**
 * 获取我当前招募中/进行中的球局（用于禁止同时发起多局）
 */
async function getMyActiveMatches() {
  const openid = getOpenid();
  if (!openid) return [];

  const db = DB();
  const { data } = await db.collection("matches")
    .where(
      db.command.or(
        { hostOpenid: openid },
        { participants: db.command.elemMatch({ openid }) }
      )
    )
    .get();

  const now = Date.now();
  // 自动过滤：招募中但开赛时间已过 = 视为过期，后台自动关闭
  const active = data.filter((m) => {
    if (m.status === "recruiting" && m.startAt && m.startAt < now) {
      closeMatch(m._id, openid).catch(() => {});
      return false;
    }
    return m.status === "recruiting" || m.status === "playing";
  });
  return active;
}

/**
 * 获取球局列表（支持筛选）
 * @param {object} filters { playType, skillRequirement, status, startAtGte, venueId, hostOpenid }
 */
async function getMatches(filters = {}) {
  const where = {};
  if (filters.status)              where.status = filters.status;
  if (filters.playType)           where.playType = filters.playType;
  if (filters.skillRequirement)    where.skillRequirement = filters.skillRequirement;
  if (filters.venueId)             where.venueId = filters.venueId;
  if (filters.hostOpenid)          where.hostOpenid = filters.hostOpenid;
  if (filters.startAtGte)         where.startAt = DB().command.gte(filters.startAtGte);

  const { data } = await DB().collection("matches")
    .where(where)
    .orderBy("startAt", "asc")
    .get();
  return data;
}

/**
 * 获取某个球房下的所有球局
 */
async function getMatchesByVenue(venueId) {
  const { data } = await DB().collection("matches")
    .where({ venueId, status: "recruiting" })
    .orderBy("startAt", "asc")
    .get();
  return data;
}

/**
 * 根据 ID 获取球局
 */
async function getMatchById(matchId) {
  // .doc().get() 返回文档对象，不是 { data: [...] }，直接取结果
  const res = await DB().collection("matches").doc(matchId).get();
  return res.data || null;
}

/**
 * 发布新球局（走云函数，服务端安全校验 + OPENID）
 */
async function publishMatch(matchData) {
  const res = await wx.cloud.callFunction({
    name: "matchService",
    data: { action: "publish", matchData }
  });
  const out = res.result || {};
  if (!out.ok) throw new Error(out.errMsg || "发布失败");
  return out;
}

/**
 * 加入球局（走云函数，服务端安全校验 + OPENID）
 */
async function joinMatch(matchId) {
  const res = await wx.cloud.callFunction({
    name: "matchService",
    data: { action: "join", matchId }
  });
  const out = res.result || {};
  if (!out.ok) throw new Error(out.errMsg || "加入失败");
  return out;
}

/**
 * 退出球局（走云函数，服务端安全校验 + OPENID）
 */
async function leaveMatch(matchId) {
  const res = await wx.cloud.callFunction({
    name: "matchService",
    data: { action: "leave", matchId }
  });
  const out = res.result || {};
  if (!out.ok) throw new Error(out.errMsg || "退出失败");
  return out;
}

/* ─────────────────────────────── 阶段2：满员确认 ─────────────────────────────── */

/**
 * 满员时，发起人确认比赛开始（走云函数）
 */
async function confirmMatch(matchId) {
  const res = await wx.cloud.callFunction({
    name: "matchService",
    data: { action: "confirm", matchId }
  });
  const out = res.result || {};
  if (!out.ok) throw new Error(out.errMsg || "确认失败");
  return out;
}

/**
 * 校验用户当前位置（走云函数）
 */
async function verifyLocation(matchId, userLat, userLon, maxDistanceKm = 0.5) {
  const res = await wx.cloud.callFunction({
    name: "matchService",
    data: { action: "verifyLocation", matchId, userLat, userLon, maxDistanceKm }
  });
  return res.result || {};
}

/* ─────────────────────────────── 阶段3：双方选择结果 ─────────────────────────────── */

/**
 * 双方提交比赛结果选择（走云函数）
 */
async function submitResultChoice(matchId, choice) {
  const res = await wx.cloud.callFunction({
    name: "matchService",
    data: { action: "submitResult", matchId, choice }
  });
  const out = res.result || {};
  if (!out.ok) throw new Error(out.errMsg || "提交失败");
  return out;
}

/* ─────────────────────────────── 阶段3之后：结算（云函数内调用，不对外暴露）────── */

/**
 * 服务端结算（云函数调用）
 * @param {string} matchId
 * @param {object} match     结算前的球局数据
 * @param {Array}  participants  已更新 resultChoice 的 participants
 */
async function _settleMatch(matchId, match, participants) {
  const db = DB();
  const openids = participants.map((p) => p.openid);
  const choices = {};
  participants.forEach((p) => { choices[p.openid] = p.resultChoice; });

  const hostChoice = choices[match.hostOpenid] || "";
  const joinOpenid = openids.find((o) => o !== match.hostOpenid);
  const joinChoice = choices[joinOpenid] || "";
  const venueId = match.venueId || null;

  // 1. 先将球局标记为 settled（最重要的一步）
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
    }

    if (winnerId) {

      // 赢家得420，系统得80，输者扣500
      await db.collection("yueqiu8_users").where({ openid: winnerId }).update({
        data: { yuedou: db.command.inc(YUEDOU_WINNER), yuedouFrozen: db.command.inc(-YUEDOU_FROZEN), yuedouSystem: db.command.inc(YUEDOU_SYSTEM) }
      });
      await db.collection("yueqiu8_users").where({ openid: loserId }).update({
        data: { yuedou: db.command.inc(-YUEDOU_LOSER), yuedouFrozen: db.command.inc(-YUEDOU_FROZEN), yuedouSystem: db.command.inc(YUEDOU_SYSTEM) }
      });

      // 写约豆记录
      await addScoreRecord(winnerId, "match_win", 10, venueId, matchId);
      await addScoreRecord(loserId, "match_lose", 0, venueId, matchId);

      const winnerNick = participants.find((p) => p.openid === winnerId)?.nickname || "某用户";
      const loserNick  = participants.find((p) => p.openid === loserId)?.nickname  || "某用户";
      await addNotice({ type: "match_settled", targetOpenid: winnerId, matchId, content: `🏆 你赢了「${loserNick}」！获得+10约豆，冻结约豆已解冻`, createdAt: db.serverDate() });
      await addNotice({ type: "match_settled", targetOpenid: loserId, matchId, content: `😅 你输了「${winnerNick}」，冻结约豆已解冻`, createdAt: db.serverDate() });
    }
  } catch (e) {
  }

  // 2. 双方完成比赛各奖励活跃积分（积分变动独立于约豆，失败不影响）
  for (const oid of openids) {
    try { await recordMatchComplete(oid); } catch (_) {}
  }
}

/**
 * 强制关闭异常/过期球局（状态改为 cancelled）
 * - 招募中（过期）：发起人可关，直接取消
 * - 进行中（超时）：发起人或参与者可关，双方冻结约豆解冻
 */
async function closeMatch(matchId, closerOpenid) {
  const res = await wx.cloud.callFunction({
    name: "matchService",
    data: { action: "close", matchId, closerOpenid }
  });
  const out = res.result || {};
  if (!out.ok) throw new Error(out.errMsg || "关闭失败");
  return out;
}

/**
 * 商家取消本球房下的异常球局，统一走云函数退回本局冻结约豆。
 */
async function cancelMatchByVenueOwner(matchId) {
  const res = await wx.cloud.callFunction({
    name: "matchService",
    data: { action: "cancelByVenueOwner", matchId }
  });
  const out = res.result || {};
  if (!out.ok) throw new Error(out.errMsg || "取消失败");
  return out;
}

/**
 * 提交对战结果（兼容旧逻辑，约豆结算由 _settleMatch 统一处理）
 */
async function submitMatchResult(matchId, winnerId, loserId) {
  const db = DB();
  await db.collection("matches").doc(matchId).update({ data: { status: "finished" } });
  await db.collection("yueqiu8_users").where({ openid: winnerId }).update({
    data: { score: db.command.inc(10), totalWin: db.command.inc(1) }
  });
  await db.collection("yueqiu8_users").where({ openid: loserId }).update({
    data: { score: db.command.inc(-5), totalLose: db.command.inc(1) }
  });
  // 注意：活跃积分（完成比赛+2）在 _settleMatch 中统一处理
}

/**
 * 活跃积分常量
 */
const SCORE_SIGNIN_BASE     = 5;   // 每日签到基础积分
const SCORE_SIGNIN_CONSECUTIVE = { 3: 3, 7: 10, 14: 15, 30: 30 }; // 连续签到阶梯奖励
const SCORE_CREATE_MATCH    = 5;   // 发起球局
const SCORE_JOIN_MATCH       = 3;   // 加入球局
const SCORE_COMPLETE_MATCH   = 2;   // 完成比赛
const SCORE_CONFIRM_RESULT   = 1;   // 确认比赛结果
const SCORE_WEEKLY_TARGET    = 3;   // 周活跃目标（场次）
const SCORE_WEEKLY_REWARD    = 15;  // 周活跃奖励
const SCORE_MONTHLY_TARGET   = 10;  // 月活跃目标（场次）
const SCORE_MONTHLY_REWARD   = 30; // 月活跃奖励

/* ─────────────────────────────── users ─────────────────────────────── */

/**
 * 获取当前用户（自动注册，自动补充缺失字段）
 */
async function getCurrentUser() {
  const openid = getOpenid();
  if (!openid) return null;

  let { data } = await DB().collection("yueqiu8_users").where({ openid }).get();

  if (data.length === 0) {
    // 首次使用，自动注册（初始约豆1000）
    await DB().collection("yueqiu8_users").add({
      data: {
        openid,
        nickname: "球友",
        score: 50,
        yuedou: YUEDOU_INITIAL,
        yuedouFrozen: 0,
        yuedouSystem: 0,
        totalWin: 0,
        totalLose: 0,
        role: "user",           // user | merchant | admin
        merchantVenueId: null,   // 商户关联的球房ID
        merchantVenueName: "",    // 商户关联的球房名称（审批通过时写入）
        // 活跃积分相关字段
        signInDays: 0,           // 累计签到天数
        lastSignInDate: null,    // 上次签到日期（YYYY-MM-DD）
        consecutiveDays: 0,      // 连续签到天数
        weeklyMatches: 0,        // 本周参与场次
        monthlyMatches: 0,       // 本月参与场次
        weeklyClaimed: false,   // 本周奖励是否已领取
        monthlyClaimed: false,   // 本月奖励是否已领取
        weeklyResetAt: null,     // 本周重置日期
        monthlyResetAt: null,    // 本月重置日期
        createdAt: DB().serverDate()
      }
    });
    ({ data } = await DB().collection("yueqiu8_users").where({ openid }).get());
  } else {
    // 老用户迁移：只补缺失字段，不能把真实的 0 余额当成“未初始化”
    const u = data[0];
    const moneyPatch = {};
    if (u.yuedou == null) moneyPatch.yuedou = YUEDOU_INITIAL;
    if (u.yuedouFrozen == null) moneyPatch.yuedouFrozen = 0;
    if (u.yuedouSystem == null) moneyPatch.yuedouSystem = 0;
    if (Object.keys(moneyPatch).length > 0) {
      await DB().collection("yueqiu8_users").where({ openid }).update({
        data: moneyPatch
      });
      ({ data } = await DB().collection("yueqiu8_users").where({ openid }).get());
    }
    // 老用户迁移：补充活跃积分缺失字段
    const needsActivityFix = u.weeklyMatches == null || u.monthlyMatches == null;
    if (needsActivityFix) {
      await DB().collection("yueqiu8_users").where({ openid }).update({
        data: {
          signInDays: 0,
          lastSignInDate: null,
          consecutiveDays: 0,
          weeklyMatches: 0,
          monthlyMatches: 0,
          weeklyClaimed: false,
          monthlyClaimed: false,
          weeklyResetAt: null,
          monthlyResetAt: null
        }
      });
      ({ data } = await DB().collection("yueqiu8_users").where({ openid }).get());
    }
  }

  return data[0];
}

/**
 * 更新当前用户的昵称和头像（用于加入球局时设置资料）
 * 同时同步到该用户已加入的所有进行中球局的 participants 数组
 * @param {object} profile  { nickname?: string, avatarUrl?: string }
 */
async function updateUserProfile(profile) {
  const openid = getOpenid();
  if (!openid) throw new Error("未登录");

  const updateData = {};
  if (profile.nickname != null) updateData.nickname = profile.nickname;
  if (profile.avatarUrl != null) updateData.avatarUrl = profile.avatarUrl;

  if (Object.keys(updateData).length === 0) return;

  await DB().collection("yueqiu8_users").where({ openid }).update({
    data: updateData
  });

  // 同步更新该用户已加入的球局 participants 里的昵称和头像
  try {
    const activeMatches = await getMyActiveMatches();
    for (const m of activeMatches) {
      const updatedParticipants = (m.participants || []).map((p) => {
        if (p.openid === openid) return { ...p, ...updateData };
        return p;
      });
      await DB().collection("matches").doc(m._id).update({
        data: { participants: updatedParticipants }
      });
    }
  } catch (e) {
    console.error("同步用户资料到球局失败（不影响主更新）", e);
  }
}

/**
 * 领取每日礼包（先到先得，每人每天一次，每次1000豆）
 * @returns {Promise<{code: string, remaining: number, totalClaimed: number}>}
 */
async function claimDailyBonus() {
  const res = await wx.cloud.callFunction({
    name: "economyService",
    data: { action: "claimDailyBonus" }
  });
  const out = res.result || {};
  if (!out.ok) throw new Error(out.errMsg || "领取失败");
  return out;
}

/**
 * 查询今日礼包领取状态
 * @returns {Promise<{claimed: boolean, remaining: number, totalClaimed: number}>}
 */
async function getDailyBonusStatus() {
  const today = _todayString();
  const openid = getOpenid();
  try {
    const poolRecord = await DB().collection("daily_pools").doc(today).get();
    const pool = poolRecord.data || {};
    return {
      claimed: (pool.claimants || []).includes(openid),
      remaining: pool.remaining || 0,
      totalClaimed: pool.totalClaimed || 0
    };
  } catch (e) {
    return { claimed: false, remaining: YUEDOU_DAILY_POOL, totalClaimed: 0 };
  }
}

/**
 * 获取今日已领取人数
 */
async function getDailyPoolInfo() {
  const today = _todayString();
  try {
    const poolRecord = await DB().collection("daily_pools").doc(today).get();
    const pool = poolRecord.data || {};
    return {
      remaining: pool.remaining || 0,
      totalClaimed: pool.totalClaimed || 0,
      claimantCount: (pool.claimants || []).length
    };
  } catch (e) {
    return { remaining: YUEDOU_DAILY_POOL, totalClaimed: 0, claimantCount: 0 };
  }
}

/**
 * 获取用户积分排名
 */
// 段位计算
const RANK_THRESHOLDS = [
  { minScore: 0,   maxScore: 9,   name: "青铜Ⅰ",  color: "#CD7F32" },
  { minScore: 10,  maxScore: 19,  name: "青铜Ⅱ",  color: "#CD7F32" },
  { minScore: 20,  maxScore: 29,  name: "白银Ⅰ",  color: "#C0C0C0" },
  { minScore: 30,  maxScore: 39,  name: "白银Ⅱ",  color: "#C0C0C0" },
  { minScore: 40,  maxScore: 49,  name: "黄金Ⅰ",  color: "#FFD700" },
  { minScore: 50,  maxScore: 59,  name: "黄金Ⅱ",  color: "#FFD700" },
  { minScore: 60,  maxScore: 69,  name: "铂金Ⅰ",  color: "#E5E4E2" },
  { minScore: 70,  maxScore: 79,  name: "铂金Ⅱ",  color: "#E5E4E2" },
  { minScore: 80,  maxScore: 89,  name: "钻石",    color: "#B9F2FF" },
  { minScore: 90,  maxScore: 100, name: "王者",    color: "#FF6B6B" },
];

function calcRankByScore(score) {
  let cfg = RANK_THRESHOLDS[0];
  for (const c of RANK_THRESHOLDS) {
    if (score >= c.minScore && score <= c.maxScore) { cfg = c; break; }
  }
  return cfg;
}

async function getLeaderboard() {
  const { data } = await DB().collection("yueqiu8_users")
    .orderBy("score", "desc")
    .limit(50)
    .get();

  return data.map((u) => {
    const rank = calcRankByScore(u.score);
    return { ...u, rankName: rank.name, rankColor: rank.color };
  });
}

/* ─────────────────────────────── 活跃积分 ─────────────────────────────── */

/**
 * 获取今日日期字符串 YYYY-MM-DD
 */
function _todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 获取本周一日期
 */
function _weekStartStr() {
  const d = new Date();
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dayStr = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dayStr}`;
}

/**
 * 获取本月第一天日期
 */
function _monthStartStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * 每日签到
 * @returns {Promise<{code: string, signInScore: number, consecutiveBonus: number, totalScore: number, consecutiveDays: number}>}
 */
async function dailySignIn() {
  const openid = getOpenid();
  if (!openid) throw new Error("未登录");

  const today = _todayStr();
  const db = DB();

  const user = await db.collection("yueqiu8_users").where({ openid }).get();
  if (!user.data.length) throw new Error("用户不存在");

  const u = user.data[0];
  const lastDate = u.lastSignInDate || "";
  const yesterday = _getYesterday();

  // 检查是否已签到
  if (lastDate === today) {
    return { code: "already_signed_in", consecutiveDays: u.consecutiveDays };
  }

  // 计算连续签到天数
  let consecutiveDays = 1;
  if (lastDate === yesterday) {
    consecutiveDays = (u.consecutiveDays || 0) + 1;
  }
  // 断签则从1开始重新累计

  // 计算奖励积分
  const baseScore = SCORE_SIGNIN_BASE;
  const consecutiveBonus = _getConsecutiveBonus(consecutiveDays);
  const totalScore = baseScore + consecutiveBonus;

  // 更新用户数据
  await db.collection("yueqiu8_users").where({ openid }).update({
    data: {
      score: db.command.inc(totalScore),
      signInDays: db.command.inc(1),
      lastSignInDate: today,
      consecutiveDays
    }
  });

  return {
    code: "ok",
    signInScore: baseScore,
    consecutiveBonus,
    totalScore,
    consecutiveDays,
    nextMilestone: _getNextMilestone(consecutiveDays)
  };
}

/**
 * 获取连续签到阶梯奖励
 */
function _getConsecutiveBonus(days) {
  const milestones = Object.keys(SCORE_SIGNIN_CONSECUTIVE).map(Number).sort((a, b) => a - b);
  for (let i = milestones.length - 1; i >= 0; i--) {
    if (days >= milestones[i]) {
      // 如果刚好多天同时满足多个里程碑，只发最高那个
      if (i === milestones.length - 1 || days < milestones[i + 1]) {
        return SCORE_SIGNIN_CONSECUTIVE[milestones[i]];
      }
    }
  }
  return 0;
}

/**
 * 获取下一个签到里程碑
 */
function _getNextMilestone(currentDays) {
  const milestones = Object.keys(SCORE_SIGNIN_CONSECUTIVE).map(Number).sort((a, b) => a - b);
  for (const m of milestones) {
    if (currentDays < m) {
      return { days: m, bonus: SCORE_SIGNIN_CONSECUTIVE[m] };
    }
  }
  return null; // 已满所有里程碑
}

/**
 * 获取昨天的日期字符串
 */
function _getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 获取签到状态（今日是否已签到）
 */
async function getSignInStatus() {
  const openid = getOpenid();
  if (!openid) return { signedInToday: false, consecutiveDays: 0 };

  const user = await DB().collection("yueqiu8_users").where({ openid }).get();
  if (!user.data.length) return { signedInToday: false, consecutiveDays: 0 };

  const u = user.data[0];
  const today = _todayStr();
  return {
    signedInToday: u.lastSignInDate === today,
    consecutiveDays: u.consecutiveDays || 0,
    nextMilestone: _getNextMilestone(u.consecutiveDays || 0),
    daysToNextMilestone: _getDaysToNextMilestone(u.consecutiveDays || 0)
  };
}

/**
 * 距离下一个里程碑还差几天
 */
function _getDaysToNextMilestone(currentDays) {
  const milestones = Object.keys(SCORE_SIGNIN_CONSECUTIVE).map(Number).sort((a, b) => a - b);
  for (const m of milestones) {
    if (currentDays < m) {
      return m - currentDays;
    }
  }
  return 0;
}

/**
 * 记录用户参与一场比赛（加入球局时调用，统计活跃）
 * @param {string} openid
 * @param {string} matchId
 * @param {boolean} isHost 是否是发起者
 */
async function recordMatchParticipation(openid, matchId, isHost = false) {
  const db = DB();
  const today = _todayStr();
  const weekStart = _weekStartStr();
  const monthStart = _monthStartStr();

  const user = await db.collection("yueqiu8_users").where({ openid }).get();
  if (!user.data.length) return;

  const u = user.data[0];
  let weeklyMatches = (u.weeklyMatches || 0) + 1;
  let monthlyMatches = (u.monthlyMatches || 0) + 1;

  // 检查是否需要重置周/月计数
  const userWeekStart = u.weeklyResetAt || "";
  const userMonthStart = u.monthlyResetAt || "";

  if (userWeekStart < weekStart) {
    weeklyMatches = 1;
  }
  if (userMonthStart < monthStart) {
    monthlyMatches = 1;
  }

  // 发放积分（发起+5，加入+3；完成比赛积分在submitMatchResult中单独处理）
  const scoreGain = isHost ? SCORE_CREATE_MATCH : SCORE_JOIN_MATCH;

  await db.collection("yueqiu8_users").where({ openid }).update({
    data: {
      score: db.command.inc(scoreGain),
      weeklyMatches,
      monthlyMatches,
      weeklyResetAt: userWeekStart < weekStart ? weekStart : u.weeklyResetAt,
      monthlyResetAt: userMonthStart < monthStart ? monthStart : u.monthlyResetAt,
      weeklyClaimed: userWeekStart < weekStart ? false : u.weeklyClaimed,
      monthlyClaimed: userMonthStart < monthStart ? false : u.monthlyClaimed
    }
  });

  return { scoreGain, weeklyMatches, monthlyMatches };
}

/**
 * 记录比赛完成（双方确认结果后调用）
 * @param {string} openid
 */
async function recordMatchComplete(openid) {
  await DB().collection("yueqiu8_users").where({ openid }).update({
    data: { score: DB().command.inc(SCORE_COMPLETE_MATCH) }
  });
}

/**
 * 记录确认比赛结果
 * @param {string} openid
 */
async function recordConfirmResult(openid) {
  await DB().collection("yueqiu8_users").where({ openid }).update({
    data: { score: DB().command.inc(SCORE_CONFIRM_RESULT) }
  });
}

/**
 * 领取周活跃奖励
 */
async function claimWeeklyReward() {
  const openid = getOpenid();
  if (!openid) throw new Error("未登录");

  const user = await DB().collection("yueqiu8_users").where({ openid }).get();
  if (!user.data.length) throw new Error("用户不存在");

  const u = user.data[0];
  const weekStart = _weekStartStr();

  // 检查是否已领取
  if (u.weeklyClaimed || u.weeklyResetAt !== weekStart) {
    return { code: "already_claimed_or_reset", weeklyMatches: u.weeklyMatches || 0 };
  }

  // 检查是否达到目标
  if ((u.weeklyMatches || 0) < SCORE_WEEKLY_TARGET) {
    return {
      code: "not_enough",
      weeklyMatches: u.weeklyMatches || 0,
      target: SCORE_WEEKLY_TARGET
    };
  }

  // 发放奖励
  await DB().collection("yueqiu8_users").where({ openid }).update({
    data: {
      score: DB().command.inc(SCORE_WEEKLY_REWARD),
      weeklyClaimed: true
    }
  });

  return {
    code: "ok",
    reward: SCORE_WEEKLY_REWARD,
    weeklyMatches: u.weeklyMatches || 0
  };
}

/**
 * 领取月活跃奖励
 */
async function claimMonthlyReward() {
  const openid = getOpenid();
  if (!openid) throw new Error("未登录");

  const user = await DB().collection("yueqiu8_users").where({ openid }).get();
  if (!user.data.length) throw new Error("用户不存在");

  const u = user.data[0];
  const monthStart = _monthStartStr();

  // 检查是否已领取
  if (u.monthlyClaimed || u.monthlyResetAt !== monthStart) {
    return { code: "already_claimed_or_reset", monthlyMatches: u.monthlyMatches || 0 };
  }

  // 检查是否达到目标
  if ((u.monthlyMatches || 0) < SCORE_MONTHLY_TARGET) {
    return {
      code: "not_enough",
      monthlyMatches: u.monthlyMatches || 0,
      target: SCORE_MONTHLY_TARGET
    };
  }

  // 发放奖励
  await DB().collection("yueqiu8_users").where({ openid }).update({
    data: {
      score: DB().command.inc(SCORE_MONTHLY_REWARD),
      monthlyClaimed: true
    }
  });

  return {
    code: "ok",
    reward: SCORE_MONTHLY_REWARD,
    monthlyMatches: u.monthlyMatches || 0
  };
}

/**
 * 获取用户活跃状态（用于前端展示）
 */
async function getActivityStatus() {
  const openid = getOpenid();
  if (!openid) return null;

  const user = await DB().collection("yueqiu8_users").where({ openid }).get();
  if (!user.data.length) return null;

  const u = user.data[0];
  const today = _todayStr();
  const weekStart = _weekStartStr();
  const monthStart = _monthStartStr();

  // 重置周/月数据（如果到了新周期）
  const weeklyMatches = (u.weeklyResetAt !== weekStart) ? 0 : (u.weeklyMatches || 0);
  const monthlyMatches = (u.monthlyResetAt !== monthStart) ? 0 : (u.monthlyMatches || 0);

  return {
    // 签到
    signedInToday: u.lastSignInDate === today,
    consecutiveDays: u.consecutiveDays || 0,
    signInDays: u.signInDays || 0,
    nextSignInMilestone: _getNextMilestone(u.consecutiveDays || 0),
    daysToNextSignInMilestone: _getDaysToNextMilestone(u.consecutiveDays || 0),
    // 周活跃
    weeklyMatches,
    weeklyTarget: SCORE_WEEKLY_TARGET,
    weeklyReward: SCORE_WEEKLY_REWARD,
    weeklyClaimed: (u.weeklyResetAt !== weekStart) ? false : (u.weeklyClaimed || false),
    weeklyProgress: Math.min(weeklyMatches / SCORE_WEEKLY_TARGET, 1),
    // 月活跃
    monthlyMatches,
    monthlyTarget: SCORE_MONTHLY_TARGET,
    monthlyReward: SCORE_MONTHLY_REWARD,
    monthlyClaimed: (u.monthlyResetAt !== monthStart) ? false : (u.monthlyClaimed || false),
    monthlyProgress: Math.min(monthlyMatches / SCORE_MONTHLY_TARGET, 1)
  };
}

/* ─────────────────────────────── notices ─────────────────────────────── */

/**
 * 写入通知
 * @param {object} notice - { type, targetOpenid, matchId, winnerId, loserId, nickname, ... }
 */
async function addNotice(notice) {
  return DB().collection("notices").add({ data: { ...notice, isRead: false } });
}

/**
 * 获取当前用户通知列表
 */
async function getNotices(openid) {
  const { data } = await DB().collection("notices")
    .where({ targetOpenid: openid })
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  return data;
}

/**
 * 标记通知已读
 */
async function markNoticeRead(noticeId) {
  return DB().collection("notices").doc(noticeId).update({ data: { isRead: true } });
}

/* ─────────────────────────────── seed ─────────────────────────────── */

/**
 * 初始化种子数据（仅在数据库为空时调用一次）
 */
async function seedIfEmpty() {
  const db = DB();
  const venuesCount = (await db.collection("venues").count()).total;
  if (venuesCount > 0) return;

  await db.collection("venues").add({
    data: {
      name: "星火台球俱乐部",
      address: "北京市朝阳区XX路88号",
      location: new db.Geo.Point(116.4074, 39.9042),
      openHours: "10:00-02:00",
      tags: ["中式八球", "空调", "停车"],
      phone: "010-12345678",
      status: "active",
      createdAt: db.serverDate()
    }
  });

  await db.collection("venues").add({
    data: {
      name: "黑八空间（城南店）",
      address: "北京市海淀区YY大道66号",
      location: new db.Geo.Point(116.3177, 39.9820),
      openHours: "12:00-03:00",
      tags: ["九球", "包间", "新桌"],
      phone: "010-87654321",
      status: "active",
      createdAt: db.serverDate()
    }
  });
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function getOpenid() {
  const app = getApp(); // 微信全局函数
  return app.globalData.openid || wx.getStorageSync("openid");
}

/**
 * 计算两点间直线距离（km），使用 Haversine 公式
 */
function _calcDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // 地球半径 km
  const dLat = _toRad(lat2 - lat1);
  const dLon = _toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(_toRad(lat1)) * Math.cos(_toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function _toRad(deg) {
  return deg * (Math.PI / 180);
}

function _todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/* ─────────────────────────────── 用户角色判断 ─────────────────────────────── */

/**
 * 获取当前用户角色
 * @returns {Promise<'user'|'merchant'|'admin'>}
 */
async function getUserRole() {
  const openid = getOpenid();
  const adminOpenids = getApp().globalData.adminOpenids || [];
  if (adminOpenids.includes(openid)) return "admin";

  const user = await DB().collection("yueqiu8_users").where({ openid }).get();
  return user.data[0]?.role || "user";
}

/**
 * 判断是否是管理员
 */
async function isAdmin() {
  const openid = getOpenid();
  const adminOpenids = getApp().globalData.adminOpenids || [];
  return adminOpenids.includes(openid);
}

/**
 * 判断是否是商户（关联了球房）
 */
async function isMerchant() {
  const user = await getCurrentUser();
  return user?.role === "merchant" && !!user?.merchantVenueId;
}

/* ─────────────────────────────── score_records / 约豆记录 ─────────────────────────────── */

/**
 * 记录约豆变动（每次获得/消耗都要写这条）
 * @param {string} userId     openid
 * @param {string} type       match_win | daily_gift | exchange | daily_bonus
 * @param {number} amount    正数为获得，负数为消耗
 * @param {string} venueId   来源球房（可选，比赛获得时有）
 * @param {string} matchId   关联球局（可选）
 */
async function addScoreRecord(userId, type, amount, venueId = null, matchId = null) {
  const db = DB();
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

/**
 * 获取我的约豆记录（积分明细）
 * @param {number} limit 返回条数，默认 20
 */
async function getMyScoreRecords(limit = 20) {
  const openid = getOpenid();
  const { data } = await DB().collection("score_records")
    .where({ userId: openid })
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return data;
}

/* ─────────────────────────────── venue_access / 球房访问记录 ─────────────────────────────── */

/**
 * 记录用户访问了某球房（加入球局时调用）
 * 如果已存在则更新访问时间和参与次数
 * @param {string} userId   openid
 * @param {string} venueId  球房ID
 * @param {string} matchId  关联球局ID
 */
async function recordVenueAccess(userId, venueId, matchId) {
  const db = DB();
  const existing = await db.collection("venue_access")
    .where({ userId, venueId })
    .get();

  if (existing.data && existing.data.length > 0) {
    // 已存在，更新
    await db.collection("venue_access").doc(existing.data[0]._id).update({
      data: {
        accessAt: db.serverDate(),
        lastMatchId: matchId,
        visitCount: db.command.inc(1)
      }
    });
  } else {
    // 不存在，新增
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

/**
 * 获取我参与过的球房列表（用于福利站筛选）
 * @returns {Promise<Array>} [{ venueId, venueName, visitCount, lastAccessAt }]
 */
async function getMyAccessibleVenues() {
  const openid = getOpenid();
  const { data } = await DB().collection("venue_access")
    .where({ userId: openid })
    .orderBy("accessAt", "desc")
    .get();

  if (!data || data.length === 0) return [];

  // 补充球房名称
  const venues = await Promise.all(data.map(async (record) => {
    try {
      const venue = await getVenueById(record.venueId);
      return {
        venueId: record.venueId,
        venueName: venue?.name || "未知球房",
        visitCount: record.visitCount || 1,
        lastAccessAt: record.accessAt,
        firstAccessAt: record.firstAccessAt
      };
    } catch (e) {
      return {
        venueId: record.venueId,
        venueName: "未知球房",
        visitCount: record.visitCount || 1,
        lastAccessAt: record.accessAt,
        firstAccessAt: record.firstAccessAt
      };
    }
  }));

  return venues;
}

/**
 * 获取用户在某球房的约豆余额（通过 score_records 汇总）
 * @param {string} userId
 * @param {string} venueId
 */
async function getUserVenueYuedou(userId, venueId) {
  const { data } = await DB().collection("score_records")
    .where({ userId, venueId })
    .get();

  // 只统计 match_win（从比赛中获得的约豆才算可兑换余额）
  let balance = 0;
  for (const record of data) {
    if (["match_win", "daily_gift", "daily_bonus"].includes(record.type)) {
      balance += record.amount;
    }
  }
  return balance;
}

/* ─────────────────────────────── mall / 积分商城 ─────────────────────────────── */

/**
 * 商城商品数据结构
 * currencyType: "yuedou" | "score"
 *   - yuedou: 约豆商品（高价值、稀缺、强者专属）
 *   - score:  积分商品（低价值、普惠、人人可换）
 * venueId: 所属球房，null = 平台通用商品
 */

/**
 * 获取商品列表（福利站版：支持按球房筛选）
 * @param {string|null} venueId  球房ID，null=全部平台商品
 * @param {string|null} category  分类：physical | virtual | null（全部）
 * @param {string|null} currencyType  货币类型：yuedou | score | null（全部）
 */
async function getGoodsList(venueId, category, currencyType) {
  const where = { status: "active" };
  if (venueId) where.venueId = venueId;
  if (category) where.category = category;
  if (currencyType) where.currencyType = currencyType;
  const { data } = await DB().collection("mall_goods")
    .where(where)
    .orderBy("sort", "asc")
    .orderBy("createdAt", "desc")
    .get();
  return data;
}

/**
 * 获取单个商品详情
 */
async function getGoodsById(goodsId) {
  const { data } = await DB().collection("mall_goods").doc(goodsId).get();
  return data || null;
}

/**
 * 兑换商品（福利站版：检查用户是否有权限兑换该球房商品）
 * @param {string} goodsId
 * @param {object} address  收货地址（虚拟商品可传 null）
 */
async function redeemGoods(goodsId, address = null) {
  const res = await wx.cloud.callFunction({
    name: "economyService",
    data: { action: "redeemGoods", goodsId, address }
  });
  const out = res.result || {};
  if (!out.ok) throw new Error(out.errMsg || "兑换失败");
  return { success: true, message: "兑换成功", currencyType: out.currencyType };
}

/**
 * 获取我的兑换记录
 */
async function getMyRedemptions() {
  const openid = getOpenid();
  const { data } = await DB().collection("mall_redemptions")
    .where({ openid })
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  return data;
}

/**
 * 管理员：获取所有兑换记录
 */
async function getAllRedemptions(status) {
  const where = status ? { status } : {};
  const { data } = await DB().collection("mall_redemptions")
    .where(where)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return data;
}

/**
 * 管理员：待跟进的兑换（待发货 + 已发货待核销），用于后台发货流程
 */
async function getRedemptionsForFulfillment() {
  const db = DB();
  const _ = db.command;
  const { data } = await db.collection("mall_redemptions")
    .where(_.or([{ status: "pending" }, { status: "shipped" }]))
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return data;
}

/**
 * 管理员：更新兑换状态（实物发货）
 */
async function updateRedemptionStatus(redemptionId, status) {
  return DB().collection("mall_redemptions").doc(redemptionId).update({
    data: { status, updatedAt: DB().serverDate() }
  });
}

/**
 * 管理员：添加/编辑商品
 * @param {object} goodsData 包含 currencyType: "yuedou" | "score"，venueId（可选）
 */
async function saveGoods(goodsData, goodsId = null) {
  const db = DB();
  const now = db.serverDate();
  const data = {
    name: goodsData.name,
    description: goodsData.description || "",
    image: goodsData.image || "",
    price: parseInt(goodsData.price) || 0,
    stock: parseInt(goodsData.stock) || 0,
    category: goodsData.category || "physical",
    currencyType: goodsData.currencyType || "score",
    venueId: goodsData.venueId || null,
    sort: parseInt(goodsData.sort) || 0,
    status: goodsData.status || "active",
    updatedAt: now
  };
  if (goodsId) {
    await db.collection("mall_goods").doc(goodsId).update({ data });
    return goodsId;
  } else {
    data.createdAt = now;
    const result = await db.collection("mall_goods").add({ data });
    return result._id;
  }
}

/**
 * 管理员：删除商品
 */
async function deleteGoods(goodsId) {
  return DB().collection("mall_goods").doc(goodsId).remove();
}

/**
 * 管理员：获取所有商品（含下架的）
 */
async function getAllGoods() {
  const { data } = await DB().collection("mall_goods")
    .orderBy("sort", "asc")
    .orderBy("createdAt", "desc")
    .get();
  return data;
}

/**
 * 商家：获取本店商品列表（含下架的）
 * @param {string} venueId
 */
async function getMyVenueGoods(venueId) {
  const { data } = await DB().collection("mall_goods")
    .where({ venueId })
    .orderBy("sort", "asc")
    .orderBy("createdAt", "desc")
    .get();
  return data;
}

/**
 * 商家：获取本店兑换订单（待处理 + 历史）
 */
async function getMyVenueRedemptions(venueId) {
  const db = DB();
  const _ = db.command;
  const { data } = await db.collection("mall_redemptions")
    .where({ venueId })
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return data;
}

module.exports = {
  // merchant_applications
  submitMerchantApplication,
  getMyMerchantApplication,
  getMerchantApplications,
  approveMerchantApplication,
  rejectMerchantApplication,
  // venues
  getVenues,
  getVenueById,
  getAllVenues,
  addVenue,
  deleteVenue,
  // matches
  getMyActiveMatches,
  closeMatch,
  cancelMatchByVenueOwner,
  getMatches,
  getMatchesByVenue,
  getMatchById,
  publishMatch,
  joinMatch,
  leaveMatch,
  confirmMatch,
  verifyLocation,
  submitResultChoice,
  submitMatchResult,
  // users
  getCurrentUser,
  updateUserProfile,
  getLeaderboard,
  calcRankByScore,
  // daily bonus
  claimDailyBonus,
  getDailyBonusStatus,
  getDailyPoolInfo,
  // 活跃积分
  dailySignIn,
  getSignInStatus,
  recordMatchParticipation,
  recordMatchComplete,
  recordConfirmResult,
  claimWeeklyReward,
  claimMonthlyReward,
  getActivityStatus,
  // notices
  addNotice,
  getNotices,
  markNoticeRead,
  // seed
  seedIfEmpty,
  // raw db
  DB,
  getOpenid,
  _calcDistance,
  // 用户角色
  getUserRole,
  isAdmin,
  isMerchant,
  // 福利站 / mall
  getGoodsList,
  getGoodsById,
  redeemGoods,
  getMyRedemptions,
  getAllRedemptions,
  getRedemptionsForFulfillment,
  updateRedemptionStatus,
  saveGoods,
  deleteGoods,
  getAllGoods,
  getMyVenueGoods,
  getMyVenueRedemptions,
  // 约豆记录 / score_records
  addScoreRecord,
  getMyScoreRecords,
  // 球房访问记录 / venue_access
  recordVenueAccess,
  getMyAccessibleVenues,
  getUserVenueYuedou,
  // 约豆常量（供页面使用）
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_LOSER,
  YUEDOU_SYSTEM,
  YUEDOU_INITIAL,
  YUEDOU_DAILY_BONUS,
  YUEDOU_DAILY_POOL,
  // 活跃积分常量（供页面使用）
  SCORE_SIGNIN_BASE,
  SCORE_SIGNIN_CONSECUTIVE,
  SCORE_CREATE_MATCH,
  SCORE_JOIN_MATCH,
  SCORE_COMPLETE_MATCH,
  SCORE_CONFIRM_RESULT,
  SCORE_WEEKLY_TARGET,
  SCORE_WEEKLY_REWARD,
  SCORE_MONTHLY_TARGET,
  SCORE_MONTHLY_REWARD
};
