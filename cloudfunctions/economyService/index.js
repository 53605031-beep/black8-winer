/**
 * 约球8 · 约豆经济云函数
 *
 * 涉及用户余额和资金池的写入必须放到云端事务里，避免重复领取或半途失败造成账本不一致。
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

async function addNotice({ targetOpenid, content }) {
  await db.collection("notices").add({
    data: {
      type: "daily_bonus",
      targetOpenid,
      content,
      isRead: false,
      createdAt: db.serverDate()
    }
  });
}

async function claimDailyBonus(openid) {
  const today = todayString();
  let result = null;

  await db.runTransaction(async (transaction) => {
    const poolRef = db.collection("daily_pools").doc(today);
    let pool = null;

    try {
      const poolRecord = await transaction.get(poolRef);
      pool = poolRecord.data || null;
    } catch (e) {
      pool = null;
    }

    const userRecord = await transaction.get(db.collection("yueqiu8_users").where({ openid }).limit(1));
    const user = userRecord.data && userRecord.data[0];
    if (!user) throw new Error("用户不存在，请先登录");

    const claimants = pool && Array.isArray(pool.claimants) ? pool.claimants : [];
    const remaining = pool ? (pool.remaining || 0) : YUEDOU_DAILY_POOL;
    const totalClaimed = pool ? (pool.totalClaimed || 0) : 0;

    if (claimants.includes(openid)) {
      result = { code: "already_claimed", remaining, totalClaimed };
      return;
    }

    if (remaining < YUEDOU_DAILY_BONUS) {
      result = { code: "pool_empty", remaining: 0, totalClaimed };
      return;
    }

    const nextRemaining = remaining - YUEDOU_DAILY_BONUS;
    const nextTotalClaimed = totalClaimed + YUEDOU_DAILY_BONUS;

    if (pool) {
      await transaction.update(poolRef, {
        data: {
          remaining: _.inc(-YUEDOU_DAILY_BONUS),
          totalClaimed: _.inc(YUEDOU_DAILY_BONUS),
          claimants: _.push(openid),
          updatedAt: db.serverDate()
        }
      });
    } else {
      await transaction.set(poolRef, {
        data: {
          totalPool: YUEDOU_DAILY_POOL,
          remaining: nextRemaining,
          totalClaimed: nextTotalClaimed,
          claimants: [openid],
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }

    await transaction.update(db.collection("yueqiu8_users").where({ openid }), {
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

    result = { code: "ok", remaining: nextRemaining, totalClaimed: nextTotalClaimed };
  });

  if (result && result.code === "ok") {
    await addNotice({
      targetOpenid: openid,
      content: `每日礼包到账 +${YUEDOU_DAILY_BONUS} 约豆，今日资金池剩余 ${result.remaining} 约豆`
    });
  }

  return result || { code: "pool_empty", remaining: 0, totalClaimed: YUEDOU_DAILY_POOL };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, errMsg: "无法获取用户身份" };

  const { action } = event || {};
  try {
    if (action === "claimDailyBonus") {
      return { ok: true, ...(await claimDailyBonus(OPENID)) };
    }
    return { ok: false, errMsg: "未知操作: " + action };
  } catch (e) {
    console.error(`economyService[${action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
