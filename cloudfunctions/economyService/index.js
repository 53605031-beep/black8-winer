/**
 * 约球8 · 约豆经济操作云函数
 *
 * 资金类操作必须在云函数事务里完成，避免前端并发点击造成重复发放或资金池透支。
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

async function addNotice(openid, remaining) {
  await db.collection("notices").add({
    data: {
      type: "daily_bonus",
      targetOpenid: openid,
      content: `每日礼包到账 +${YUEDOU_DAILY_BONUS} 约豆，今日资金池剩余 ${remaining} 约豆`,
      isRead: false,
      createdAt: db.serverDate()
    }
  });
}

async function claimDailyBonus(openid) {
  const today = todayString();
  const poolRef = db.collection("daily_pools").doc(today);
  const claimRef = db.collection("daily_bonus_claims").doc(`${today}_${openid}`);

  let result = null;

  await db.runTransaction(async (transaction) => {
    const userRecord = await transaction.get(db.collection("yueqiu8_users").where({ openid }).limit(1));
    const user = userRecord.data && userRecord.data[0];
    if (!user) throw new Error("用户不存在，请先登录");

    const claimRecord = await transaction.get(claimRef).catch(() => null);
    if (claimRecord && claimRecord.data) {
      const poolRecord = await transaction.get(poolRef).catch(() => null);
      const pool = poolRecord && poolRecord.data ? poolRecord.data : {};
      result = {
        code: "already_claimed",
        remaining: pool.remaining || 0,
        totalClaimed: pool.totalClaimed || 0
      };
      return;
    }

    const poolRecord = await transaction.get(poolRef).catch(() => null);
    const pool = poolRecord && poolRecord.data
      ? poolRecord.data
      : {
          totalPool: YUEDOU_DAILY_POOL,
          remaining: YUEDOU_DAILY_POOL,
          totalClaimed: 0,
          claimants: []
        };

    if ((pool.claimants || []).includes(openid)) {
      await transaction.set(claimRef, {
        data: {
          openid,
          date: today,
          amount: 0,
          migratedFromPool: true,
          createdAt: db.serverDate()
        }
      });
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

    if (!poolRecord || !poolRecord.data) {
      await transaction.set(poolRef, {
        data: {
          totalPool: YUEDOU_DAILY_POOL,
          remaining: YUEDOU_DAILY_POOL - YUEDOU_DAILY_BONUS,
          totalClaimed: YUEDOU_DAILY_BONUS,
          claimants: [openid],
          createdAt: db.serverDate()
        }
      });
    } else {
      await transaction.update(poolRef, {
        data: {
          remaining: _.inc(-YUEDOU_DAILY_BONUS),
          totalClaimed: _.inc(YUEDOU_DAILY_BONUS),
          claimants: _.push(openid)
        }
      });
    }

    await transaction.update(db.collection("yueqiu8_users").where({ openid }), {
      data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
    });
    await transaction.set(claimRef, {
      data: {
        openid,
        date: today,
        amount: YUEDOU_DAILY_BONUS,
        createdAt: db.serverDate()
      }
    });

    result = {
      code: "ok",
      remaining: (pool.remaining || 0) - YUEDOU_DAILY_BONUS,
      totalClaimed: (pool.totalClaimed || 0) + YUEDOU_DAILY_BONUS
    };
  });

  if (result && result.code === "ok") {
    await addNotice(openid, result.remaining);
  }

  return result || { code: "unknown" };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, errMsg: "无法获取用户身份" };

  try {
    if (event && event.action === "claimDailyBonus") {
      return { ok: true, ...(await claimDailyBonus(OPENID)) };
    }
    return { ok: false, errMsg: "未知操作" };
  } catch (e) {
    console.error("economyService error", e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
