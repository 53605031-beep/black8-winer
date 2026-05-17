const YUEDOU_FROZEN = 500;
const YUEDOU_SYSTEM = 80;
const YUEDOU_WINNER = YUEDOU_FROZEN - YUEDOU_SYSTEM;
const YUEDOU_LOSER = YUEDOU_FROZEN;

function toFrozenAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * 结算冻结约豆：
 * - 赢方拿回自己的冻结约豆，再获得输方扣除系统抽成后的奖励。
 * - 输方只失去已经冻结的约豆，不再额外扣余额，避免余额被扣成负数。
 */
function buildSettlementDeltas(winnerFrozen = YUEDOU_FROZEN, loserFrozen = YUEDOU_FROZEN) {
  const winnerStake = toFrozenAmount(winnerFrozen);
  const loserStake = toFrozenAmount(loserFrozen);
  const systemFee = Math.min(YUEDOU_SYSTEM, loserStake);
  const winnerReward = Math.max(loserStake - systemFee, 0);

  return {
    winner: {
      yuedou: winnerStake + winnerReward,
      yuedouFrozen: -winnerStake,
      yuedouSystem: 0
    },
    loser: {
      yuedou: 0,
      yuedouFrozen: -loserStake,
      yuedouSystem: systemFee
    },
    systemFee,
    winnerReward
  };
}

module.exports = {
  YUEDOU_FROZEN,
  YUEDOU_SYSTEM,
  YUEDOU_WINNER,
  YUEDOU_LOSER,
  buildSettlementDeltas
};
