/**
 * 约球8 · 约豆经济云函数
 *
 * 余额发放必须放在云端事务里，避免用户双击或多设备同时领取导致重复到账。
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

async function getUserDocRefByOpenid(transaction, openid) {
  const userRes = await transaction.get(db.collection("yueqiu8_users").where({ openid }));
  const user = userRes.data && userRes.data[0];
  if (!user || !user._id) throw new Error("用户不存在，请先登录");
  return db.collection("yueqiu8_users").doc(user._id);
}

async function getDocDataOrNull(transaction, docRef) {
  try {
    const res = await transaction.get(docRef);
    return res.data || null;
  } catch (e) {
    return null;
  }
}

async function addNotice(openid, content) {
  await db.collection("notices").add({
    data: {
      type: "daily_bonus",
      targetOpenid: openid,
      content,
      isRead: false,
      createdAt: db.serverDate()
    }
  });
}

async function claimDailyBonus(openid) {
  const today = todayString();
  const poolRef = db.collection("daily_pools").doc(today);
  const claimRef = db.collection("daily_bonus_claims").doc(`${today}_${openid}`);

  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const existingClaim = await getDocDataOrNull(transaction, claimRef);
    const pool = await getDocDataOrNull(transaction, poolRef);

    if (existingClaim) {
      outcome = {
        code: "already_claimed",
        remaining: pool ? (pool.remaining || 0) : YUEDOU_DAILY_POOL,
        totalClaimed: pool ? (pool.totalClaimed || 0) : 0
      };
      return;
    }

    const remaining = pool ? (pool.remaining || 0) : YUEDOU_DAILY_POOL;
    const totalClaimed = pool ? (pool.totalClaimed || 0) : 0;
    if (remaining < YUEDOU_DAILY_BONUS) {
      outcome = { code: "pool_empty", remaining: 0, totalClaimed };
      return;
    }

    const userRef = await getUserDocRefByOpenid(transaction, openid);
    const nextRemaining = remaining - YUEDOU_DAILY_BONUS;
    const nextTotalClaimed = totalClaimed + YUEDOU_DAILY_BONUS;

    transaction.update(userRef, {
      data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
    });

    if (pool) {
      transaction.update(poolRef, {
        data: {
          remaining: _.inc(-YUEDOU_DAILY_BONUS),
          totalClaimed: _.inc(YUEDOU_DAILY_BONUS),
          claimants: _.push(openid)
        }
      });
    } else {
      transaction.set(poolRef, {
        data: {
          totalPool: YUEDOU_DAILY_POOL,
          remaining: nextRemaining,
          totalClaimed: nextTotalClaimed,
          claimants: [openid],
          createdAt: db.serverDate()
        }
      });
    }

    transaction.set(claimRef, {
      data: {
        openid,
        date: today,
        amount: YUEDOU_DAILY_BONUS,
        createdAt: db.serverDate()
      }
    });

    outcome = { code: "ok", remaining: nextRemaining, totalClaimed: nextTotalClaimed };
  });

  if (outcome && outcome.code === "ok") {
    await addNotice(
      openid,
      `每日礼包到账 +${YUEDOU_DAILY_BONUS} 约豆，今日资金池剩余 ${outcome.remaining} 约豆`
    );
  }

  return outcome || { code: "pool_empty", remaining: 0, totalClaimed: YUEDOU_DAILY_POOL };
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
