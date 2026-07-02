/**
 * 约球8 · 经济系统云函数
 *
 * 所有会改变约豆余额的公共福利动作放在服务端执行，避免客户端并发写库造成重复发放。
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const YUEDOU_DAILY_BONUS = 1000;
const YUEDOU_DAILY_POOL = 50000;
const MAX_DAILY_REDEMPTIONS = 3;

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function getUserByOpenid(openid, transaction) {
  const query = db.collection("yueqiu8_users").where({ openid });
  const res = transaction ? await transaction.get(query) : await query.get();
  return res.data[0] || null;
}

async function claimDailyBonus(openid) {
  const today = todayString();
  const claimId = `${today}_${openid}`;
  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const claimRef = db.collection("daily_claims").doc(claimId);
    try {
      const claim = await transaction.get(claimRef);
      if (claim.data) {
        outcome = {
          code: "already_claimed",
          remaining: claim.data.remainingAfter ?? 0,
          totalClaimed: claim.data.totalClaimedAfter ?? 0
        };
        return;
      }
    } catch (_) {}

    const poolRef = db.collection("daily_pools").doc(today);
    let pool = null;
    let poolExists = false;
    try {
      const poolRecord = await transaction.get(poolRef);
      pool = poolRecord.data || null;
      poolExists = !!pool;
    } catch (_) {}

    if (!pool) {
      pool = {
        _id: today,
        totalPool: YUEDOU_DAILY_POOL,
        remaining: YUEDOU_DAILY_POOL,
        totalClaimed: 0,
        claimants: []
      };
    }

    if ((pool.remaining || 0) < YUEDOU_DAILY_BONUS) {
      outcome = {
        code: "pool_empty",
        remaining: Math.max(pool.remaining || 0, 0),
        totalClaimed: pool.totalClaimed || 0
      };
      return;
    }

    const user = await getUserByOpenid(openid, transaction);
    if (!user) throw new Error("用户不存在，请先登录");

    const remainingAfter = (pool.remaining || 0) - YUEDOU_DAILY_BONUS;
    const totalClaimedAfter = (pool.totalClaimed || 0) + YUEDOU_DAILY_BONUS;

    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
    });

    if (poolExists) {
      await transaction.update(poolRef, {
        data: {
          remaining: _.inc(-YUEDOU_DAILY_BONUS),
          totalClaimed: _.inc(YUEDOU_DAILY_BONUS),
          claimants: _.push(openid)
        }
      });
    } else {
      await transaction.set(poolRef, {
        data: {
          totalPool: YUEDOU_DAILY_POOL,
          remaining: remainingAfter,
          totalClaimed: totalClaimedAfter,
          claimants: [openid],
          createdAt: db.serverDate()
        }
      });
    }

    await transaction.set(claimRef, {
      data: {
        openid,
        date: today,
        amount: YUEDOU_DAILY_BONUS,
        remainingAfter,
        totalClaimedAfter,
        createdAt: db.serverDate()
      }
    });

    await transaction.add(db.collection("score_records"), {
      data: {
        userId: openid,
        type: "daily_bonus",
        amount: YUEDOU_DAILY_BONUS,
        venueId: null,
        matchId: null,
        createdAt: db.serverDate()
      }
    });

    outcome = { code: "ok", remaining: remainingAfter, totalClaimed: totalClaimedAfter };
  });

  if (outcome && outcome.code === "ok") {
    try {
      await db.collection("notices").add({
        data: {
          type: "daily_bonus",
          targetOpenid: openid,
          content: `每日礼包到账 +${YUEDOU_DAILY_BONUS} 约豆，今日资金池剩余 ${outcome.remaining} 约豆`,
          isRead: false,
          createdAt: db.serverDate()
        }
      });
    } catch (e) {
      console.error("每日礼包通知发送失败", e);
    }
  }

  return outcome || { code: "already_claimed", remaining: 0, totalClaimed: 0 };
}

async function redeemGoods(openid, goodsId, address = null) {
  if (!goodsId) throw new Error("缺少商品ID");

  const today = todayString();
  const counterRef = db.collection("mall_daily_redemptions").doc(`${today}_${openid}`);
  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const goodsRef = db.collection("mall_goods").doc(goodsId);
    const goodsSnap = await transaction.get(goodsRef);
    const goods = goodsSnap.data;
    if (!goods) throw new Error("商品不存在");
    if (goods.status !== "active") throw new Error("商品已下架");
    if ((goods.stock || 0) <= 0) throw new Error("库存不足");

    if (goods.venueId) {
      const access = await transaction.get(
        db.collection("venue_access").where({ userId: openid, venueId: goods.venueId })
      );
      if (!access.data || access.data.length === 0) {
        throw new Error("只有参与过该球房比赛的球友才能兑换此福利");
      }
    }

    const user = await getUserByOpenid(openid, transaction);
    if (!user) throw new Error("用户不存在，请先登录");

    let todayCount = 0;
    try {
      const counter = await transaction.get(counterRef);
      todayCount = counter.data?.count || 0;
    } catch (_) {}
    if (todayCount >= MAX_DAILY_REDEMPTIONS) {
      throw new Error("今日兑换次数已用完（每天最多兑换3次）");
    }

    const price = goods.price || 0;
    const currencyType = goods.currencyType || "score";
    const currencyName = currencyType === "yuedou" ? "约豆" : "积分";
    const balance = currencyType === "yuedou" ? (user.yuedou ?? 0) : (user.score ?? 0);
    if (balance < price) {
      throw new Error(`${currencyName}不足，需要 ${price} ${currencyName}，你只有 ${balance} ${currencyName}`);
    }

    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: currencyType === "yuedou"
        ? { yuedou: _.inc(-price) }
        : { score: _.inc(-price) }
    });

    await transaction.update(goodsRef, {
      data: { stock: _.inc(-1), redeemedCount: _.inc(1) }
    });

    if (todayCount > 0) {
      await transaction.update(counterRef, {
        data: { count: _.inc(1), updatedAt: db.serverDate() }
      });
    } else {
      await transaction.set(counterRef, {
        data: { openid, date: today, count: 1, createdAt: db.serverDate(), updatedAt: db.serverDate() }
      });
    }

    await transaction.add(db.collection("mall_redemptions"), {
      data: {
        openid,
        nickname: user.nickname || "球友",
        goodsId,
        goodsName: goods.name,
        goodsImage: goods.image || "",
        price,
        currencyType,
        category: goods.category || "physical",
        venueId: goods.venueId || null,
        address,
        status: goods.category === "virtual" ? "completed" : "pending",
        createdAt: db.serverDate()
      }
    });

    if (currencyType === "yuedou") {
      await transaction.add(db.collection("score_records"), {
        data: {
          userId: openid,
          type: "exchange",
          amount: -price,
          venueId: goods.venueId || null,
          matchId: null,
          createdAt: db.serverDate()
        }
      });
    }

    outcome = { success: true, message: "兑换成功", currencyType };
  });

  return outcome || { success: true, message: "兑换成功" };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, errMsg: "无法获取用户身份" };

  const { action, goodsId, address } = event || {};
  try {
    if (action === "claimDailyBonus") {
      return { ok: true, ...(await claimDailyBonus(OPENID)) };
    }
    if (action === "redeemGoods") {
      return { ok: true, ...(await redeemGoods(OPENID, goodsId, address || null)) };
    }
    return { ok: false, errMsg: "未知操作: " + action };
  } catch (e) {
    console.error(`economyService[${action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
