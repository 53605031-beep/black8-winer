const assert = require("assert");
const {
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_SYSTEM,
  buildSettlementDeltas
} = require("../cloudfunctions/matchService/settlement");

function applyDelta(user, delta) {
  return {
    yuedou: user.yuedou + delta.yuedou,
    yuedouFrozen: user.yuedouFrozen + delta.yuedouFrozen,
    yuedouSystem: user.yuedouSystem + delta.yuedouSystem
  };
}

const winnerBefore = {
  yuedou: 9500,
  yuedouFrozen: YUEDOU_FROZEN,
  yuedouSystem: 0
};
const loserBefore = {
  yuedou: 0,
  yuedouFrozen: YUEDOU_FROZEN,
  yuedouSystem: 0
};

const deltas = buildSettlementDeltas(
  winnerBefore.yuedouFrozen,
  loserBefore.yuedouFrozen
);
const winnerAfter = applyDelta(winnerBefore, deltas.winner);
const loserAfter = applyDelta(loserBefore, deltas.loser);

assert.strictEqual(deltas.winnerReward, YUEDOU_WINNER);
assert.strictEqual(deltas.systemFee, YUEDOU_SYSTEM);
assert.deepStrictEqual(winnerAfter, {
  yuedou: 9500 + YUEDOU_FROZEN + YUEDOU_WINNER,
  yuedouFrozen: 0,
  yuedouSystem: 0
});
assert.deepStrictEqual(loserAfter, {
  yuedou: 0,
  yuedouFrozen: 0,
  yuedouSystem: YUEDOU_SYSTEM
});

console.log("settlement tests passed");
