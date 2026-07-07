/**
 * 约球8 · 约豆经济云函数
 *
 * 每日礼包会改用户余额和当天资金池，必须在服务端事务里完成，
 * 否则用户连续点击或多端同时领取时会重复到账。
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

async function getUserByOpenidInTransaction(transaction, openid) {
  const res = await transaction.get(db.collection("yueqiu8_users").where({ openid }));
  return res.data && res.data[0] ? res.data[0] : null;
}

async function claimDailyBonus(openid) {
  const today = todayString();
  const claimId = `${today}_${openid}`;
  let result;

  await db.runTransaction(async (transaction) => {
    const claimRef = db.collection("daily_claims").doc(claimId);
    const poolRef = db.collection("daily_pools").doc(today);

    try {
      const existingClaim = await transaction.get(claimRef);
      if (existingClaim.data) {
        const poolSnap = await transaction.get(poolRef).catch(() => ({ data: null }));
        const pool = poolSnap.data || {};
        result = {
          code: "already_claimed",
          remaining: pool.remaining || 0,
          totalClaimed: pool.totalClaimed || 0
        };
        return;
      }
    } catch (_) {
      // doc().get() 不存在时会抛错，这里表示今天还没领。
    }

    const user = await getUserByOpenidInTransaction(transaction, openid);
    if (!user) throw new Error("用户不存在，请先登录");

    let pool;
    try {
      const poolSnap = await transaction.get(poolRef);
      pool = poolSnap.data;
    } catch (_) {
      pool = null;
    }

    const remaining = pool ? (pool.remaining || 0) : YUEDOU_DAILY_POOL;
    const totalClaimed = pool ? (pool.totalClaimed || 0) : 0;
    if (remaining < YUEDOU_DAILY_BONUS) {
      result = { code: "pool_empty", remaining: 0, totalClaimed };
      return;
    }

    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
    });

    if (pool) {
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
          remaining: YUEDOU_DAILY_POOL - YUEDOU_DAILY_BONUS,
          totalClaimed: YUEDOU_DAILY_BONUS,
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

    result = {
      code: "ok",
      remaining: remaining - YUEDOU_DAILY_BONUS,
      totalClaimed: totalClaimed + YUEDOU_DAILY_BONUS
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
    }).catch((e) => console.error("每日礼包通知写入失败", e));
  }

  return result || { code: "already_claimed", remaining: 0, totalClaimed: 0 };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, errMsg: "无法获取用户身份" };
  }

  try {
    if ((event || {}).action === "claimDailyBonus") {
      return { ok: true, ...(await claimDailyBonus(OPENID)) };
    }
    return { ok: false, errMsg: "未知操作" };
  } catch (e) {
    console.error("economyService error", e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
