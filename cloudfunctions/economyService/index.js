/**
 * 约球8 · 约豆经济云函数
 *
 * 所有会改用户约豆的钱包操作都放到云端执行，避免前端重复点击或重放请求导致重复发放。
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

async function ensureDailyPool(today) {
  try {
    await db.collection("daily_pools").doc(today).get();
  } catch (e) {
    try {
      await db.collection("daily_pools").add({
        data: {
          _id: today,
          totalPool: YUEDOU_DAILY_POOL,
          remaining: YUEDOU_DAILY_POOL,
          totalClaimed: 0,
          claimants: [],
          createdAt: db.serverDate()
        }
      });
    } catch (createErr) {
      // 并发创建时，另一笔请求可能已经建好资金池；继续进入事务读取即可。
      console.warn("daily pool create skipped", createErr);
    }
  }
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
  await ensureDailyPool(today);

  let result = null;
  await db.runTransaction(async (transaction) => {
    const poolRef = db.collection("daily_pools").doc(today);
    const poolRes = await transaction.get(poolRef);
    const pool = poolRes.data;
    if (!pool) throw new Error("今日资金池不存在");

    const claimants = pool.claimants || [];
    if (claimants.includes(openid)) {
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

    const userRes = await transaction.get(db.collection("yueqiu8_users").where({ openid }));
    const user = userRes.data[0];
    if (!user) throw new Error("用户不存在，请先登录");

    await transaction.update(poolRef, {
      data: {
        remaining: _.inc(-YUEDOU_DAILY_BONUS),
        totalClaimed: _.inc(YUEDOU_DAILY_BONUS),
        claimants: _.push(openid)
      }
    });
    await transaction.update(db.collection("yueqiu8_users").doc(user._id), {
      data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
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
      remaining: (pool.remaining || 0) - YUEDOU_DAILY_BONUS,
      totalClaimed: (pool.totalClaimed || 0) + YUEDOU_DAILY_BONUS
    };
  });

  if (result && result.code === "ok") {
    try {
      await addNotice(openid, result.remaining);
    } catch (e) {
      console.error("每日礼包通知失败", e);
    }
  }

  return result;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, errMsg: "无法获取用户身份" };
  }

  try {
    const { action } = event || {};
    if (action === "claimDailyBonus") {
      return { ok: true, ...(await claimDailyBonus(OPENID)) };
    }
    return { ok: false, errMsg: "未知操作: " + action };
  } catch (e) {
    console.error(`economyService[${event && event.action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
