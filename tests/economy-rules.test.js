const assert = require("assert");
const matchEconomy = require("../cloudfunctions/matchService/economy");
const { buildMissingYuedouUpdate } = require("../utils/economyRules");

function testZeroYuedouIsNotMigrated() {
  assert.deepStrictEqual(
    buildMissingYuedouUpdate({ yuedou: 0, yuedouFrozen: 0, yuedouSystem: 0, score: 50 }),
    {}
  );
  assert.deepStrictEqual(
    buildMissingYuedouUpdate({ score: 50 }),
    { yuedou: 10000, yuedouFrozen: 0, yuedouSystem: 0 }
  );
}

function testSettlementMath() {
  const match = { hostOpenid: "host", headcountTarget: 2 };
  const settlement = matchEconomy.buildSettlement(match, [
    { openid: "host", resultChoice: "win", yuedouFrozen: 500 },
    { openid: "joiner", resultChoice: "lose", yuedouFrozen: 500 }
  ]);

  assert.deepStrictEqual(settlement, {
    winnerId: "host",
    loserId: "joiner",
    winnerStake: 500,
    loserStake: 500,
    winnerGain: 920,
    loserGain: 0,
    systemGain: 80
  });
}

function testSettlementRejectsBadMatchShapes() {
  assert.throws(() => matchEconomy.buildSettlement(
    { hostOpenid: "host", headcountTarget: 2 },
    [{ openid: "host", resultChoice: "win", yuedouFrozen: 500 }]
  ), /两人球局/);

  assert.strictEqual(matchEconomy.buildSettlement(
    { hostOpenid: "host", headcountTarget: 2 },
    [
      { openid: "host", resultChoice: "win", yuedouFrozen: 500 },
      { openid: "joiner", resultChoice: "win", yuedouFrozen: 500 }
    ]
  ), null);
}

function testForceCloseTimeGuard() {
  const now = new Date("2026-07-07T12:00:00Z").getTime();
  assert.strictEqual(matchEconomy.canForceClosePlaying(null, now), false);
  assert.strictEqual(matchEconomy.canForceClosePlaying("bad-date", now), false);
  assert.strictEqual(matchEconomy.canForceClosePlaying("2026-07-07T08:00:00Z", now), false);
  assert.strictEqual(matchEconomy.canForceClosePlaying("2026-07-07T05:30:00Z", now), true);
}

testZeroYuedouIsNotMigrated();
testSettlementMath();
testSettlementRejectsBadMatchShapes();
testForceCloseTimeGuard();

console.log("economy rules ok");
