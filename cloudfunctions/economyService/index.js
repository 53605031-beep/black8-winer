/**
 * 约球8 · 约豆和商城原子操作云函数
 *
 * 这些操作会同时改用户余额、资金池、库存和记录，必须放在云函数事务里，
 * 避免前端重复点击或并发请求造成重复发放、超卖或扣款失败。
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const YUEDOU_INITIAL = 10000;
const YUEDOU_DAILY_BONUS = 1000;
const YUEDOU_DAILY_POOL = 50000;

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function getUserByOpenid(openid) {
  const res = await db.collection("yueqiu8_users").where({ openid }).limit(1).get();
  return res.data[0] || null;
}

async function ensureUser(openid) {
  const existing = await getUserByOpenid(openid);
  if (existing) {
    const patch = {};
    if (existing.yuedou == null) patch.yuedou = YUEDOU_INITIAL;
    if (existing.yuedouFrozen == null) patch.yuedouFrozen = 0;
    if (existing.yuedouSystem == null) patch.yuedouSystem = 0;
    if (Object.keys(patch).length > 0) {
      await db.collection("yueqiu8_users").doc(existing._id).update({ data: patch });
      return { ...existing, ...patch };
    }
    return existing;
  }

  await db.collection("yueqiu8_users").add({
    data: {
      openid,
      nickname: "球友",
      score: 50,
      yuedou: YUEDOU_INITIAL,
      yuedouFrozen: 0,
      yuedouSystem: 0,
      totalWin: 0,
      totalLose: 0,
      role: "user",
      merchantVenueId: null,
      merchantVenueName: "",
      signInDays: 0,
      lastSignInDate: null,
      consecutiveDays: 0,
      weeklyMatches: 0,
      monthlyMatches: 0,
      weeklyClaimed: false,
      monthlyClaimed: false,
      weeklyResetAt: null,
      monthlyResetAt: null,
      createdAt: db.serverDate()
    }
  });

  return getUserByOpenid(openid);
}

async function addNotice({ type, targetOpenid, content }) {
  await db.collection("notices").add({
    data: {
      type,
      targetOpenid,
      content,
      isRead: false,
      createdAt: db.serverDate()
    }
  });
}

async function claimDailyBonus(openid) {
  const user = await ensureUser(openid);
  if (!user || !user._id) throw new Error("用户不存在，请先登录");

  const today = todayString();
  let result = null;

  await db.runTransaction(async (transaction) => {
    const poolRef = transaction.collection("daily_pools").doc(today);
    const userRef = transaction.collection("yueqiu8_users").doc(user._id);

    let pool = null;
    let poolExists = false;
    try {
      const poolRecord = await poolRef.get();
      pool = poolRecord.data || null;
      poolExists = !!pool;
    } catch (e) {
      pool = null;
    }

    if (!pool) {
      pool = {
        totalPool: YUEDOU_DAILY_POOL,
        remaining: YUEDOU_DAILY_POOL,
        totalClaimed: 0,
        claimants: []
      };
    }

    if ((pool.claimants || []).includes(openid)) {
      result = { code: "already_claimed", remaining: pool.remaining, totalClaimed: pool.totalClaimed };
      return;
    }

    if ((pool.remaining || 0) < YUEDOU_DAILY_BONUS) {
      result = { code: "pool_empty", remaining: 0, totalClaimed: pool.totalClaimed || 0 };
      return;
    }

    const remainingAfter = pool.remaining - YUEDOU_DAILY_BONUS;
    const totalClaimedAfter = (pool.totalClaimed || 0) + YUEDOU_DAILY_BONUS;

    if (poolExists) {
      await poolRef.update({
        data: {
          remaining: _.inc(-YUEDOU_DAILY_BONUS),
          totalClaimed: _.inc(YUEDOU_DAILY_BONUS),
          claimants: _.push(openid)
        }
      });
    } else {
      await poolRef.set({
        data: {
          totalPool: YUEDOU_DAILY_POOL,
          remaining: remainingAfter,
          totalClaimed: totalClaimedAfter,
          claimants: [openid],
          createdAt: db.serverDate()
        }
      });
    }

    await userRef.update({
      data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
    });

    result = { code: "ok", remaining: remainingAfter, totalClaimed: totalClaimedAfter };
  });

  if (result && result.code === "ok") {
    await addNotice({
      type: "daily_bonus",
      targetOpenid: openid,
      content: `每日礼包到账 +${YUEDOU_DAILY_BONUS} 约豆，今日资金池剩余 ${result.remaining} 约豆`
    });
  }

  return result || { code: "pool_empty", remaining: 0, totalClaimed: 0 };
}

async function redeemGoods(openid, goodsId, address) {
  if (!goodsId) throw new Error("缺少商品ID");

  const user = await ensureUser(openid);
  if (!user || !user._id) throw new Error("用户不存在，请先登录");

  const goodsRes = await db.collection("mall_goods").doc(goodsId).get();
  const goods = goodsRes.data;
  if (!goods) throw new Error("商品不存在");
  if (goods.status !== "active") throw new Error("商品已下架");
  if ((goods.stock || 0) <= 0) throw new Error("库存不足");

  if (goods.venueId) {
    const accessRes = await db.collection("venue_access")
      .where({ userId: openid, venueId: goods.venueId })
      .limit(1)
      .get();
    if (!accessRes.data || accessRes.data.length === 0) {
      throw new Error("只有参与过该球房比赛的球友才能兑换此福利");
    }
  }

  const today = todayString();
  const todayStart = new Date(today + "T00:00:00").getTime();
  const countRes = await db.collection("mall_redemptions")
    .where({
      openid,
      createdAt: _.gte(new Date(todayStart))
    })
    .count();
  if (countRes.total >= 3) throw new Error("今日兑换次数已用完（每天最多兑换3次）");

  const price = goods.price || 0;
  const currencyType = goods.currencyType || "score";
  const currencyName = currencyType === "yuedou" ? "约豆" : "积分";

  await db.runTransaction(async (transaction) => {
    const userRef = transaction.collection("yueqiu8_users").doc(user._id);
    const goodsRef = transaction.collection("mall_goods").doc(goodsId);

    const userCheck = await userRef.get();
    const latestUser = userCheck.data;
    if (!latestUser) throw new Error("用户不存在");

    const balance = currencyType === "yuedou" ? (latestUser.yuedou || 0) : (latestUser.score || 0);
    if (balance < price) {
      throw new Error(`${currencyName}不足，需要 ${price} ${currencyName}，你只有 ${balance} ${currencyName}`);
    }

    const goodsCheck = await goodsRef.get();
    const latestGoods = goodsCheck.data;
    if (!latestGoods || latestGoods.status !== "active") throw new Error("商品已下架");
    if ((latestGoods.stock || 0) <= 0) throw new Error("库存不足");

    await userRef.update({
      data: currencyType === "yuedou"
        ? { yuedou: _.inc(-price) }
        : { score: _.inc(-price) }
    });

    await goodsRef.update({
      data: { stock: _.inc(-1), redeemedCount: _.inc(1) }
    });

    await transaction.collection("mall_redemptions").add({
      data: {
        openid,
        nickname: latestUser.nickname || "球友",
        goodsId,
        goodsName: latestGoods.name,
        goodsImage: latestGoods.image || "",
        price,
        currencyType,
        category: latestGoods.category || "physical",
        venueId: latestGoods.venueId || null,
        address: address || null,
        status: latestGoods.category === "virtual" ? "completed" : "pending",
        createdAt: db.serverDate()
      }
    });

    if (currencyType === "yuedou") {
      await transaction.collection("score_records").add({
        data: {
          userId: openid,
          type: "exchange",
          amount: -price,
          venueId: latestGoods.venueId || null,
          matchId: null,
          createdAt: db.serverDate()
        }
      });
    }
  });

  return { success: true, currencyType };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, errMsg: "无法获取用户身份" };

  try {
    const { action, goodsId, address } = event || {};
    if (action === "claimDailyBonus") {
      return { ok: true, ...(await claimDailyBonus(OPENID)) };
    }
    if (action === "redeemGoods") {
      return { ok: true, ...(await redeemGoods(OPENID, goodsId, address)) };
    }
    return { ok: false, errMsg: "未知操作: " + action };
  } catch (e) {
    console.error("economyService error", e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
