/**
 * 约球8 · 约豆/商城云函数
 *
 * 余额、资金池、库存这类会被多人同时修改的数据必须放在云端事务里处理。
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const YUEDOU_DAILY_BONUS = 1000;
const YUEDOU_DAILY_POOL = 50000;

function todayString() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function isMissingDocError(err) {
  const msg = err && (err.errMsg || err.message || String(err));
  return /not\s*found|not\s*exist|does\s*not\s*exist|document.*missing/i.test(msg || "");
}

async function txGetDocOrNull(transaction, collectionName, docId) {
  try {
    const res = await transaction.collection(collectionName).doc(docId).get();
    return res.data || null;
  } catch (err) {
    if (isMissingDocError(err)) return null;
    throw err;
  }
}

async function getUserByOpenid(openid) {
  const res = await db.collection("yueqiu8_users").where({ openid }).get();
  return res.data[0] || null;
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
  const user = await getUserByOpenid(openid);
  if (!user || !user._id) throw new Error("用户不存在，请先登录");

  const today = todayString();
  const claimId = `${today}_${openid}`;
  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const existingClaim = await txGetDocOrNull(transaction, "daily_claims", claimId);
    const pool = await txGetDocOrNull(transaction, "daily_pools", today) || {
      totalPool: YUEDOU_DAILY_POOL,
      remaining: YUEDOU_DAILY_POOL,
      totalClaimed: 0,
      claimants: []
    };

    if (existingClaim || (pool.claimants || []).includes(openid)) {
      outcome = { code: "already_claimed", remaining: pool.remaining || 0, totalClaimed: pool.totalClaimed || 0 };
      return;
    }

    if ((pool.remaining || 0) < YUEDOU_DAILY_BONUS) {
      outcome = { code: "pool_empty", remaining: 0, totalClaimed: pool.totalClaimed || 0 };
      return;
    }

    const userRes = await transaction.collection("yueqiu8_users").doc(user._id).get();
    if (!userRes.data) throw new Error("用户不存在，请先登录");

    const remaining = pool.remaining - YUEDOU_DAILY_BONUS;
    const totalClaimed = (pool.totalClaimed || 0) + YUEDOU_DAILY_BONUS;
    if (pool.createdAt) {
      await transaction.collection("daily_pools").doc(today).update({
        data: {
          remaining: _.inc(-YUEDOU_DAILY_BONUS),
          totalClaimed: _.inc(YUEDOU_DAILY_BONUS),
          claimants: _.push(openid)
        }
      });
    } else {
      await transaction.collection("daily_pools").doc(today).set({
        data: {
          totalPool: YUEDOU_DAILY_POOL,
          remaining,
          totalClaimed,
          claimants: [openid],
          createdAt: db.serverDate()
        }
      });
    }

    await transaction.collection("daily_claims").doc(claimId).set({
      data: {
        openid,
        date: today,
        amount: YUEDOU_DAILY_BONUS,
        createdAt: db.serverDate()
      }
    });
    await transaction.collection("yueqiu8_users").doc(user._id).update({
      data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
    });

    outcome = { code: "ok", remaining, totalClaimed };
  });

  if (outcome && outcome.code === "ok") {
    await addNotice({
      type: "daily_bonus",
      targetOpenid: openid,
      content: `每日礼包到账 +${YUEDOU_DAILY_BONUS} 约豆，今日资金池剩余 ${outcome.remaining} 约豆`
    });
  }

  return outcome || { code: "pool_empty", remaining: 0, totalClaimed: YUEDOU_DAILY_POOL };
}

async function redeemGoods(openid, goodsId, address) {
  if (!goodsId) throw new Error("商品不存在");

  const user = await getUserByOpenid(openid);
  if (!user || !user._id) throw new Error("用户不存在，请先登录");

  const goodsSnapshot = await db.collection("mall_goods").doc(goodsId).get();
  const goods = goodsSnapshot.data;
  if (!goods) throw new Error("商品不存在");
  if (goods.status !== "active") throw new Error("商品已下架");

  if (goods.venueId) {
    const access = await db.collection("venue_access").where({ userId: openid, venueId: goods.venueId }).get();
    if (!access.data || access.data.length === 0) {
      throw new Error("只有参与过该球房比赛的球友才能兑换此福利");
    }
  }

  const today = todayString();
  const todayStart = new Date(`${today}T00:00:00`).getTime();
  const countRes = await db.collection("mall_redemptions")
    .where({ openid, createdAt: _.gte(new Date(todayStart)) })
    .count();
  if ((countRes.total || 0) >= 3) throw new Error("今日兑换次数已用完（每天最多兑换3次）");

  let currencyType = goods.currencyType || "score";
  await db.runTransaction(async (transaction) => {
    const userRes = await transaction.collection("yueqiu8_users").doc(user._id).get();
    const latestUser = userRes.data;
    if (!latestUser) throw new Error("用户不存在，请先登录");

    const goodsRes = await transaction.collection("mall_goods").doc(goodsId).get();
    const latestGoods = goodsRes.data;
    if (!latestGoods) throw new Error("商品不存在");
    if (latestGoods.status !== "active") throw new Error("商品已下架");
    if ((latestGoods.stock || 0) <= 0) throw new Error("库存不足");

    const price = latestGoods.price || 0;
    currencyType = latestGoods.currencyType || "score";
    const currencyName = currencyType === "yuedou" ? "约豆" : "积分";
    const fieldName = currencyType === "yuedou" ? "yuedou" : "score";
    const balance = latestUser[fieldName] || 0;
    if (balance < price) throw new Error(`${currencyName}不足，需要 ${price} ${currencyName}，你只有 ${balance} ${currencyName}`);

    await transaction.collection("yueqiu8_users").doc(user._id).update({
      data: { [fieldName]: _.inc(-price) }
    });
    await transaction.collection("mall_goods").doc(goodsId).update({
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

  return { code: "ok", currencyType };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, errMsg: "无法获取用户身份" };

  try {
    switch (event.action) {
      case "claimDailyBonus":
        return { ok: true, ...(await claimDailyBonus(OPENID)) };
      case "redeemGoods":
        return { ok: true, ...(await redeemGoods(OPENID, event.goodsId, event.address)) };
      default:
        return { ok: false, errMsg: "未知操作: " + event.action };
    }
  } catch (err) {
    console.error(`economyService[${event.action}] error`, err);
    return { ok: false, errMsg: err.message || String(err) };
  }
};
