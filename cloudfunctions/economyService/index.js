const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const YUEDOU_INITIAL = 10000;
const YUEDOU_DAILY_BONUS = 1000;
const YUEDOU_DAILY_POOL = 50000;

function todayString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function ensureDailyPool(today) {
  try {
    await db.collection("daily_pools").doc(today).get();
    return;
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
      // 并发首领时可能已有另一个请求创建成功，后续事务会重新读取。
      console.warn("daily pool create skipped", createErr);
    }
  }
}

async function getUserByOpenidTx(transaction, openid) {
  const res = await transaction.get(db.collection("yueqiu8_users").where({ openid }));
  return (res.data && res.data[0]) || null;
}

async function claimDailyBonus(openid) {
  const today = todayString();
  const claimId = `${today}_${openid}`;
  await ensureDailyPool(today);

  let result = null;
  await db.runTransaction(async (transaction) => {
    const claimRef = db.collection("daily_bonus_claims").doc(claimId);
    try {
      const existingClaim = await transaction.get(claimRef);
      if (existingClaim.data) {
        const poolSnap = await transaction.get(db.collection("daily_pools").doc(today));
        const pool = poolSnap.data || {};
        result = {
          code: "already_claimed",
          remaining: pool.remaining || 0,
          totalClaimed: pool.totalClaimed || 0
        };
        return;
      }
    } catch (e) {
      // 没有领取记录才继续发放。
    }

    const poolSnap = await transaction.get(db.collection("daily_pools").doc(today));
    const pool = poolSnap.data || {};
    const remaining = pool.remaining || 0;
    const totalClaimed = pool.totalClaimed || 0;
    if (remaining < YUEDOU_DAILY_BONUS) {
      result = { code: "pool_empty", remaining: 0, totalClaimed };
      return;
    }

    const user = await getUserByOpenidTx(transaction, openid);
    if (!user) {
      await transaction.add(db.collection("yueqiu8_users"), {
        data: {
          openid,
          nickname: "球友",
          score: 50,
          yuedou: YUEDOU_INITIAL + YUEDOU_DAILY_BONUS,
          yuedouFrozen: 0,
          yuedouSystem: 0,
          totalWin: 0,
          totalLose: 0,
          role: "user",
          merchantVenueId: null,
          merchantVenueName: "",
          createdAt: db.serverDate()
        }
      });
    }

    await transaction.add(db.collection("daily_bonus_claims"), {
      data: {
        _id: claimId,
        openid,
        date: today,
        amount: YUEDOU_DAILY_BONUS,
        createdAt: db.serverDate()
      }
    });
    if (user) {
      await transaction.update(db.collection("yueqiu8_users").where({ openid }), {
        data: { yuedou: _.inc(YUEDOU_DAILY_BONUS) }
      });
    }
    await transaction.update(db.collection("daily_pools").doc(today), {
      data: {
        remaining: _.inc(-YUEDOU_DAILY_BONUS),
        totalClaimed: _.inc(YUEDOU_DAILY_BONUS),
        claimants: _.push(openid)
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
        isRead: false,
        createdAt: db.serverDate()
      }
    });
  }

  return result || { code: "already_claimed", remaining: 0, totalClaimed: 0 };
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
