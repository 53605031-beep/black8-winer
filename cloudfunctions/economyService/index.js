/**
 * 约球8 · 资产类云函数
 *
 * 小程序前端不能直接跑云数据库事务，所以兑换这类“扣余额 + 扣库存 + 写记录”
 * 的操作必须放在云函数里一次完成，避免用户扣款或库存写一半。
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const YUEDOU_DAILY_BONUS = 1000;
const YUEDOU_DAILY_POOL = 50000;

async function getUserByOpenid(openid) {
  const res = await db.collection("yueqiu8_users").where({ openid }).limit(1).get();
  return res.data[0] || null;
}

async function getGoodsById(goodsId) {
  const res = await db.collection("mall_goods").doc(goodsId).get();
  return res.data || null;
}

function todayStartDate() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildDailyClaimId(date, openid) {
  return `${date}_${openid}`;
}

function getBalance(user, currencyType) {
  return currencyType === "yuedou" ? (user.yuedou || 0) : (user.score || 0);
}

async function assertVenueAccess(openid, venueId) {
  if (!venueId) return;
  const { data } = await db.collection("venue_access")
    .where({ userId: openid, venueId })
    .limit(1)
    .get();
  if (!data || data.length === 0) {
    throw new Error("只有参与过该球房比赛的球友才能兑换此福利");
  }
}

async function assertDailyLimit(openid) {
  const { total } = await db.collection("mall_redemptions")
    .where({
      openid,
      createdAt: _.gte(todayStartDate())
    })
    .count();
  if (total >= 3) throw new Error("今日兑换次数已用完（每天最多兑换3次）");
}

async function claimDailyBonus(openid) {
  const user = await getUserByOpenid(openid);
  if (!user) throw new Error("用户不存在，请先登录");

  const today = todayString();
  const claimId = buildDailyClaimId(today, openid);

  return db.runTransaction(async (transaction) => {
    const claimRef = transaction.collection("daily_bonus_claims").doc(claimId);
    const poolRef = transaction.collection("daily_pools").doc(today);

    const claimSnap = await claimRef.get().catch(() => ({ data: null }));
    const poolSnap = await poolRef.get().catch(() => ({ data: null }));
    const pool = poolSnap.data || null;
    const remaining = pool ? (pool.remaining || 0) : YUEDOU_DAILY_POOL;
    const totalClaimed = pool ? (pool.totalClaimed || 0) : 0;
    const oldClaimants = (pool && pool.claimants) || [];

    if (claimSnap.data || oldClaimants.includes(openid)) {
      if (!claimSnap.data) {
        await claimRef.set({
          data: {
            openid,
            date: today,
            source: "legacy_claimants",
            createdAt: db.serverDate()
          }
        });
      }
      return { ok: true, code: "already_claimed", remaining, totalClaimed };
    }

    if (remaining < YUEDOU_DAILY_BONUS) {
      return { ok: true, code: "pool_empty", remaining: 0, totalClaimed };
    }

    const latestUserSnap = await transaction.collection("yueqiu8_users").doc(user._id).get();
    if (!latestUserSnap.data) throw new Error("用户不存在，请先登录");

    await transaction.collection("yueqiu8_users").doc(user._id).update({
      data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
    });

    if (pool) {
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
          remaining: YUEDOU_DAILY_POOL - YUEDOU_DAILY_BONUS,
          totalClaimed: YUEDOU_DAILY_BONUS,
          claimants: [openid],
          createdAt: db.serverDate()
        }
      });
    }

    await claimRef.set({
      data: { openid, date: today, createdAt: db.serverDate() }
    });

    await transaction.collection("notices").add({
      data: {
        type: "daily_bonus",
        targetOpenid: openid,
        content: `每日礼包到账 +${YUEDOU_DAILY_BONUS} 约豆，今日资金池剩余 ${remaining - YUEDOU_DAILY_BONUS} 约豆`,
        createdAt: db.serverDate(),
        isRead: false
      }
    });

    await transaction.collection("score_records").add({
      data: {
        userId: openid,
        type: "daily_bonus",
        amount: YUEDOU_DAILY_BONUS,
        venueId: null,
        matchId: null,
        createdAt: db.serverDate()
      }
    });

    return {
      ok: true,
      code: "ok",
      remaining: remaining - YUEDOU_DAILY_BONUS,
      totalClaimed: totalClaimed + YUEDOU_DAILY_BONUS
    };
  });
}

async function redeemGoods(openid, goodsId, address = null) {
  if (!goodsId) throw new Error("商品参数错误");

  const user = await getUserByOpenid(openid);
  if (!user) throw new Error("用户不存在，请先登录");

  const goods = await getGoodsById(goodsId);
  if (!goods) throw new Error("商品不存在");
  if (goods.status !== "active") throw new Error("商品已下架");
  if ((goods.stock || 0) <= 0) throw new Error("库存不足");

  await assertVenueAccess(openid, goods.venueId);
  await assertDailyLimit(openid);

  const currencyType = goods.currencyType || "score";
  const currencyName = currencyType === "yuedou" ? "约豆" : "积分";
  const price = Number(goods.price) || 0;
  if (getBalance(user, currencyType) < price) {
    throw new Error(`${currencyName}不足，需要 ${price} ${currencyName}`);
  }

  await db.runTransaction(async (transaction) => {
    const userRecord = await transaction.collection("yueqiu8_users").doc(user._id).get();
    const latestUser = userRecord.data;
    if (!latestUser) throw new Error("用户不存在，请先登录");
    if (getBalance(latestUser, currencyType) < price) throw new Error(`${currencyName}不足`);

    const goodsRecord = await transaction.collection("mall_goods").doc(goodsId).get();
    const latestGoods = goodsRecord.data;
    if (!latestGoods || latestGoods.status !== "active") throw new Error("商品已下架");
    if ((latestGoods.stock || 0) <= 0) throw new Error("库存不足");

    const userUpdate = currencyType === "yuedou"
      ? { yuedou: _.inc(-price) }
      : { score: _.inc(-price) };
    await transaction.collection("yueqiu8_users").doc(user._id).update({ data: userUpdate });

    await transaction.collection("mall_goods").doc(goodsId).update({
      data: {
        stock: _.inc(-1),
        redeemedCount: _.inc(1)
      }
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
        address,
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

  return { code: "ok", message: "兑换成功", currencyType };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, errMsg: "无法获取用户身份" };

  try {
    switch (event.action) {
      case "claimDailyBonus":
        return await claimDailyBonus(OPENID);
      case "redeemGoods":
        return {
          ok: true,
          ...(await redeemGoods(OPENID, event.goodsId, event.address || null))
        };
      default:
        return { ok: false, errMsg: "未知操作: " + event.action };
    }
  } catch (e) {
    console.error(`economyService[${event.action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};

exports.__test__ = {
  YUEDOU_DAILY_BONUS,
  YUEDOU_DAILY_POOL,
  buildDailyClaimId
};
