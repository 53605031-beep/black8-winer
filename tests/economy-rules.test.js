const assert = require("assert");
const { buildSettlementDeltas } = require("../cloudfunctions/matchService/economy");

function applySettlement(startYuedou, startFrozen, deltaYuedou, deltaFrozen) {
  return {
    yuedou: startYuedou + deltaYuedou,
    yuedouFrozen: startFrozen + deltaFrozen
  };
}

function testHostWins() {
  const match = { hostOpenid: "host" };
  const participants = [
    { openid: "host", nickname: "发起人", yuedouFrozen: 500, resultChoice: "win" },
    { openid: "joiner", nickname: "参与者", yuedouFrozen: 500, resultChoice: "lose" }
  ];

  const deltas = buildSettlementDeltas(match, participants);

  assert.strictEqual(deltas.winnerId, "host");
  assert.strictEqual(deltas.loserId, "joiner");
  assert.strictEqual(deltas.winnerYuedouDelta, 920);
  assert.strictEqual(deltas.loserYuedouDelta, 0);
  assert.strictEqual(deltas.recordAmount, 420);

  const host = applySettlement(9500, 500, deltas.winnerYuedouDelta, deltas.winnerFrozenDelta);
  const joiner = applySettlement(9500, 500, deltas.loserYuedouDelta, deltas.loserFrozenDelta);

  assert.deepStrictEqual(host, { yuedou: 10420, yuedouFrozen: 0 });
  assert.deepStrictEqual(joiner, { yuedou: 9500, yuedouFrozen: 0 });
}

function testJoinerWins() {
  const match = { hostOpenid: "host" };
  const participants = [
    { openid: "host", nickname: "发起人", yuedouFrozen: 500, resultChoice: "lose" },
    { openid: "joiner", nickname: "参与者", yuedouFrozen: 500, resultChoice: "win" }
  ];

  const deltas = buildSettlementDeltas(match, participants);

  assert.strictEqual(deltas.winnerId, "joiner");
  assert.strictEqual(deltas.loserId, "host");
  assert.strictEqual(deltas.winnerYuedouDelta, 920);
  assert.strictEqual(deltas.loserYuedouDelta, 0);
}

function testRejectsIncompleteMatch() {
  assert.throws(
    () => buildSettlementDeltas(
      { hostOpenid: "host" },
      [{ openid: "host", yuedouFrozen: 500, resultChoice: "win" }]
    ),
    /两人球局/
  );
}

testHostWins();
testJoinerWins();
testRejectsIncompleteMatch();

console.log("economy rules ok");
