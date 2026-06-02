/**
 * 约球8 · 约豆经济操作云函数
 *
 * 资金类操作必须在云端按 OPENID 处理，避免前端重复点击或多设备并发造成重复到账。
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

async function getUserDocInTransaction(transaction, openid) {
  const res = await transaction.get(db.collection("yueqiu8_users").where({ openid }));
  const user = res.data && res.data[0];
  if (!user) throw new Error("用户不存在，请先登录");
  return user;
}

async function claimDailyBonus(openid) {
  const today = todayString();
  const claimId = `${today}_${openid}`;

  return db.runTransaction(async (transaction) => {
    const claimRef = db.collection("daily_bonus_claims").doc(claimId);
    const poolRef = db.collection("daily_pools").doc(today);

    const claimSnap = await transaction.get(claimRef).catch(() => ({ data: null }));
    if (claimSnap.data) {
      const poolSnap = await transaction.get(poolRef).catch(() => ({ data: null }));
      const pool = poolSnap.data || {};
      return {
        ok: true,
        code: "already_claimed",
        remaining: pool.remaining || 0,
        totalClaimed: pool.totalClaimed || 0
      };
    }

    const poolSnap = await transaction.get(poolRef).catch(() => ({ data: null }));
    const pool = poolSnap.data || null;
    const remaining = pool ? (pool.remaining || 0) : YUEDOU_DAILY_POOL;
    const totalClaimed = pool ? (pool.totalClaimed || 0) : 0;
    const oldClaimants = (pool && pool.claimants) || [];

    // 兼容旧数据：如果旧 claimants 已有记录，也不能再发一次。
    if (oldClaimants.includes(openid)) {
      await transaction.set(claimRef, {
        data: { openid, date: today, createdAt: db.serverDate(), source: "legacy_claimants" }
      });
      return { ok: true, code: "already_claimed", remaining, totalClaimed };
    }

    if (remaining < YUEDOU_DAILY_BONUS) {
      return { ok: true, code: "pool_empty", remaining: 0, totalClaimed };
    }

    const user = await getUserDocInTransaction(transaction, openid);
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
      data: { openid, date: today, createdAt: db.serverDate() }
    });

    await transaction.add(db.collection("notices"), {
      data: {
        type: "daily_bonus",
        targetOpenid: openid,
        content: `每日礼包到账 +${YUEDOU_DAILY_BONUS} 约豆，今日资金池剩余 ${remaining - YUEDOU_DAILY_BONUS} 约豆`,
        createdAt: db.serverDate(),
        isRead: false
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

    return {
      ok: true,
      code: "ok",
      remaining: remaining - YUEDOU_DAILY_BONUS,
      totalClaimed: totalClaimed + YUEDOU_DAILY_BONUS
    };
  });
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, errMsg: "无法获取用户身份" };
  }

  try {
    const { action } = event || {};
    if (action === "claimDailyBonus") {
      return await claimDailyBonus(OPENID);
    }
    return { ok: false, errMsg: "未知操作: " + action };
  } catch (e) {
    const action = event && event.action;
    console.error(`economyService[${action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
