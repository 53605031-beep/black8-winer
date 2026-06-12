const assert = require("assert");
const {
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  buildFinalParticipants,
  buildSettlement
} = require("../cloudfunctions/matchService/economyRules");

function testWinnerGetsFrozenBackPlusPrize() {
  const settlement = buildSettlement(
    { hostOpenid: "host" },
    [
      { openid: "host", resultChoice: "win", yuedouFrozen: YUEDOU_FROZEN },
      { openid: "joiner", resultChoice: "lose", yuedouFrozen: YUEDOU_FROZEN }
    ]
  );

  assert.strictEqual(settlement.consistent, true);
  assert.strictEqual(settlement.winnerId, "host");
  assert.strictEqual(settlement.loserId, "joiner");
  assert.strictEqual(settlement.winnerLiquidDelta, YUEDOU_FROZEN + YUEDOU_WINNER);
  assert.strictEqual(settlement.loserLiquidDelta, 0);
  assert.strictEqual(settlement.winnerFrozenDelta, -YUEDOU_FROZEN);
  assert.strictEqual(settlement.loserFrozenDelta, -YUEDOU_FROZEN);
}

function testConflictingChoicesDoNotSettle() {
  const settlement = buildSettlement(
    { hostOpenid: "host" },
    [
      { openid: "host", resultChoice: "win", yuedouFrozen: YUEDOU_FROZEN },
      { openid: "joiner", resultChoice: "win", yuedouFrozen: YUEDOU_FROZEN }
    ]
  );

  assert.strictEqual(settlement.consistent, false);
}

function testDuplicateParticipantIsRejected() {
  assert.throws(
    () => buildSettlement(
      { hostOpenid: "host" },
      [
        { openid: "host", resultChoice: "win", yuedouFrozen: YUEDOU_FROZEN },
        { openid: "host", resultChoice: "lose", yuedouFrozen: YUEDOU_FROZEN }
      ]
    ),
    /两人球局/
  );
}

function testFinalParticipantsClearFrozenSnapshots() {
  const finalParticipants = buildFinalParticipants([
    { openid: "host", yuedouFrozen: YUEDOU_FROZEN },
    { openid: "joiner", yuedouFrozen: YUEDOU_FROZEN }
  ]);

  assert.deepStrictEqual(finalParticipants.map((p) => p.yuedouFrozen), [0, 0]);
}

testWinnerGetsFrozenBackPlusPrize();
testConflictingChoicesDoNotSettle();
testDuplicateParticipantIsRejected();
testFinalParticipantsClearFrozenSnapshots();

console.log("economy rules tests passed");
