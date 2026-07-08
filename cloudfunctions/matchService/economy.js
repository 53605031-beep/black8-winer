const YUEDOU_WINNER_REWARD = 420;
const YUEDOU_SYSTEM_FEE = 80;

function getFrozenAmount(participant, fallbackAmount) {
  const amount = Number(participant && participant.yuedouFrozen);
  if (Number.isFinite(amount) && amount > 0) return amount;
  return fallbackAmount;
}

function buildSettlementDeltas({ winner, loser, frozenFallback }) {
  const winnerFrozen = getFrozenAmount(winner, frozenFallback);
  const loserFrozen = getFrozenAmount(loser, frozenFallback);

  return {
    winner: {
      openid: winner.openid,
      yuedouDelta: winnerFrozen + YUEDOU_WINNER_REWARD,
      frozenDelta: -winnerFrozen,
      recordAmount: YUEDOU_WINNER_REWARD
    },
    loser: {
      openid: loser.openid,
      yuedouDelta: 0,
      frozenDelta: -loserFrozen,
      recordAmount: 0
    },
    systemFee: YUEDOU_SYSTEM_FEE
  };
}

module.exports = {
  YUEDOU_WINNER_REWARD,
  YUEDOU_SYSTEM_FEE,
  buildSettlementDeltas
};
