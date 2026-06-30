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
