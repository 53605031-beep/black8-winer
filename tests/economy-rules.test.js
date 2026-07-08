const assert = require("assert");
const { buildSettlementDeltas } = require("../cloudfunctions/matchService/economy");

function testDefaultStakeSettlement() {
  const deltas = buildSettlementDeltas({
    winner: { openid: "winner", yuedouFrozen: 500 },
    loser: { openid: "loser", yuedouFrozen: 500 },
    frozenFallback: 500
  });

  assert.strictEqual(deltas.winner.openid, "winner");
  assert.strictEqual(deltas.winner.yuedouDelta, 920);
  assert.strictEqual(deltas.winner.frozenDelta, -500);
  assert.strictEqual(deltas.winner.recordAmount, 420);

  assert.strictEqual(deltas.loser.openid, "loser");
  assert.strictEqual(deltas.loser.yuedouDelta, 0);
  assert.strictEqual(deltas.loser.frozenDelta, -500);
  assert.strictEqual(deltas.loser.recordAmount, 0);

  assert.strictEqual(deltas.systemFee, 80);
}

function testPerMatchFrozenAmountIsUsed() {
  const deltas = buildSettlementDeltas({
    winner: { openid: "winner", yuedouFrozen: 300 },
    loser: { openid: "loser", yuedouFrozen: 700 },
    frozenFallback: 500
  });

  assert.strictEqual(deltas.winner.yuedouDelta, 720);
  assert.strictEqual(deltas.winner.frozenDelta, -300);
  assert.strictEqual(deltas.loser.yuedouDelta, 0);
  assert.strictEqual(deltas.loser.frozenDelta, -700);
}

testDefaultStakeSettlement();
testPerMatchFrozenAmountIsUsed();

console.log("economy rules tests passed");
