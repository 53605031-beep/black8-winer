const YUEDOU_FROZEN = 500;
const YUEDOU_WINNER = 420;
const YUEDOU_SYSTEM = 80;

function getFrozenAmount(participant) {
  const frozen = participant && participant.yuedouFrozen;
  return typeof frozen === "number" ? frozen : YUEDOU_FROZEN;
}

function buildSettlementDeltas(winner, loser) {
  const winnerFrozen = getFrozenAmount(winner);
  const loserFrozen = getFrozenAmount(loser);

  return {
    winner: {
      yuedouDelta: winnerFrozen + YUEDOU_WINNER,
      frozenDelta: -winnerFrozen,
      systemDelta: YUEDOU_SYSTEM,
      recordAmount: YUEDOU_WINNER
    },
    loser: {
      // The loser already paid the stake when it was frozen, so do not debit liquid balance again.
      yuedouDelta: 0,
      frozenDelta: -loserFrozen,
      systemDelta: YUEDOU_SYSTEM,
      recordAmount: 0
    }
  };
}

module.exports = {
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_SYSTEM,
  buildSettlementDeltas,
  getFrozenAmount
};
