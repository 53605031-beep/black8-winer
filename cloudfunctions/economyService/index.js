/**
 * 约球8 · 约豆经济操作云函数
 *
 * 目前负责每日礼包领取。放在云函数里做事务，避免客户端并发点击重复发约豆。
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

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
  return (res.data && res.data[0]) || null;
}

async function ensureDailyPool(today) {
  const initialPool = {
    totalPool: YUEDOU_DAILY_POOL,
    remaining: YUEDOU_DAILY_POOL,
    totalClaimed: 0,
    claimants: [],
    createdAt: db.serverDate()
  };

  try {
    const pool = await db.collection("daily_pools").doc(today).get();
    if (pool && pool.data) return;
  } catch (e) {
    // 文档不存在时继续创建；其它错误会在 set 或事务阶段暴露。
  }

  try {
    await db.collection("daily_pools").doc(today).set({ data: initialPool });
  } catch (e) {
    // 并发首领时可能已经由另一个请求创建，重新读取确认即可。
    const pool = await db.collection("daily_pools").doc(today).get();
    if (!pool || !pool.data) throw e;
  }
}

async function claimDailyBonus(openid) {
  const today = todayString();
  const user = await getUserByOpenid(openid);
  if (!user || !user._id) throw new Error("用户不存在");

  await ensureDailyPool(today);

  let result = null;
  await db.runTransaction(async (transaction) => {
    result = null;
    const poolRecord = await transaction.get(db.collection("daily_pools").doc(today));
    const pool = poolRecord.data;
    if (!pool) throw new Error("今日资金池不存在");

    if ((pool.claimants || []).includes(openid)) {
      result = {
        code: "already_claimed",
        remaining: pool.remaining || 0,
        totalClaimed: pool.totalClaimed || 0
      };
      return;
    }

    if ((pool.remaining || 0) < YUEDOU_DAILY_BONUS) {
      result = {
        code: "pool_empty",
        remaining: 0,
        totalClaimed: pool.totalClaimed || 0
      };
      return;
    }

    const latestUserRecord = await transaction.get(db.collection("yueqiu8_users").doc(user._id));
    if (!latestUserRecord.data) throw new Error("用户不存在");

    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
    });
    await transaction.update(db.collection("daily_pools").doc(today), {
      data: {
        remaining: _.inc(-YUEDOU_DAILY_BONUS),
        totalClaimed: _.inc(YUEDOU_DAILY_BONUS),
        claimants: _.push(openid)
      }
    });

    result = {
      code: "ok",
      remaining: (pool.remaining || 0) - YUEDOU_DAILY_BONUS,
      totalClaimed: (pool.totalClaimed || 0) + YUEDOU_DAILY_BONUS
    };
  });

  if (result && result.code === "ok") {
    await db.collection("notices").add({
      data: {
        type: "daily_bonus",
        targetOpenid: openid,
        content: `每日礼包到账 +${YUEDOU_DAILY_BONUS} 约豆，今日资金池剩余 ${result.remaining} 约豆`,
        createdAt: db.serverDate(),
        isRead: false
      }
    });
  }

  return result || { code: "pool_empty", remaining: 0, totalClaimed: 0 };
}

async function redeemGoods(openid, goodsId, address) {
  if (!goodsId) throw new Error("缺少商品ID");

  const user = await getUserByOpenid(openid);
  if (!user || !user._id) throw new Error("用户不存在");

  const goodsBefore = await db.collection("mall_goods").doc(goodsId).get();
  const goods = goodsBefore.data;
  if (!goods) throw new Error("商品不存在");
  if (goods.status !== "active") throw new Error("商品已下架");

  if (goods.venueId) {
    const access = await db.collection("venue_access")
      .where({ userId: openid, venueId: goods.venueId })
      .limit(1)
      .get();
    if (!access.data || access.data.length === 0) {
      throw new Error("只有参与过该球房比赛的球友才能兑换此福利");
    }
  }

  const currencyType = goods.currencyType || "score";
  const currencyName = currencyType === "yuedou" ? "约豆" : "积分";
  const price = parseInt(goods.price, 10) || 0;

  const today = todayString();
  const todayStart = new Date(today + "T00:00:00").getTime();
  const { total } = await db.collection("mall_redemptions")
    .where({
      openid,
      createdAt: _.gte(new Date(todayStart))
    })
    .count();
  if (total >= 3) throw new Error("今日兑换次数已用完（每天最多兑换3次）");
  await ensureDailyPool(today);
  const counterKey = openid.replace(/[^A-Za-z0-9_]/g, "_");

  await db.runTransaction(async (transaction) => {
    const poolRecord = await transaction.get(db.collection("daily_pools").doc(today));
    const pool = poolRecord.data || {};
    const redemptionCounts = pool.redemptionCounts || {};
    const redeemedToday = Math.max(Number(redemptionCounts[counterKey]) || 0, total);
    if (redeemedToday >= 3) throw new Error("今日兑换次数已用完（每天最多兑换3次）");

    const latestUserRecord = await transaction.get(db.collection("yueqiu8_users").doc(user._id));
    const latestUser = latestUserRecord.data;
    if (!latestUser) throw new Error("用户不存在");

    const latestGoodsRecord = await transaction.get(db.collection("mall_goods").doc(goodsId));
    const latestGoods = latestGoodsRecord.data;
    if (!latestGoods) throw new Error("商品不存在");
    if (latestGoods.status !== "active") throw new Error("商品已下架");
    if ((latestGoods.stock || 0) <= 0) throw new Error("库存不足");

    const latestPrice = parseInt(latestGoods.price, 10) || 0;
    const latestCurrencyType = latestGoods.currencyType || "score";
    const latestCurrencyName = latestCurrencyType === "yuedou" ? "约豆" : "积分";
    const balance = latestCurrencyType === "yuedou" ? (latestUser.yuedou || 0) : (latestUser.score || 0);
    if (balance < latestPrice) {
      throw new Error(`${latestCurrencyName}不足，需要 ${latestPrice} ${latestCurrencyName}，你只有 ${balance} ${latestCurrencyName}`);
    }

    const userUpdate = latestCurrencyType === "yuedou"
      ? { yuedou: _.inc(-latestPrice) }
      : { score: _.inc(-latestPrice) };
    await transaction.update(db.collection("yueqiu8_users").doc(user._id), { data: userUpdate });
    await transaction.update(db.collection("mall_goods").doc(goodsId), {
      data: {
        stock: _.inc(-1),
        redeemedCount: _.inc(1)
      }
    });
    await transaction.update(db.collection("daily_pools").doc(today), {
      data: {
        [`redemptionCounts.${counterKey}`]: redeemedToday + 1,
        redemptionCounterUpdatedAt: db.serverDate()
      }
    });
    await transaction.add(db.collection("mall_redemptions"), {
      data: {
        openid,
        nickname: latestUser.nickname || "球友",
        goodsId,
        goodsName: latestGoods.name,
        goodsImage: latestGoods.image || "",
        price: latestPrice,
        currencyType: latestCurrencyType,
        category: latestGoods.category || "physical",
        venueId: latestGoods.venueId || null,
        address: address || null,
        status: latestGoods.category === "virtual" ? "completed" : "pending",
        createdAt: db.serverDate()
      }
    });

    if (latestCurrencyType === "yuedou") {
      await transaction.add(db.collection("score_records"), {
        data: {
          userId: openid,
          type: "exchange",
          amount: -latestPrice,
          venueId: latestGoods.venueId || null,
          matchId: null,
          createdAt: db.serverDate()
        }
      });
    }
  });

  return { success: true, message: "兑换成功", currencyType, currencyName, price };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, errMsg: "无法获取用户身份" };

  try {
    const action = event && event.action;
    if (action === "claimDailyBonus") {
      return { ok: true, ...(await claimDailyBonus(OPENID)) };
    }
    if (action === "redeemGoods") {
      return { ok: true, ...(await redeemGoods(OPENID, event.goodsId, event.address)) };
    }
    return { ok: false, errMsg: "未知操作: " + action };
  } catch (e) {
    console.error("economyService error", e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
