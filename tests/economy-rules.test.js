const assert = require("assert");

const cloudDB = require("../utils/cloudDB");
const {
  buildSettlementDeltas,
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_SYSTEM
} = require("../cloudfunctions/matchService/economy");

const zeroBalancePatch = cloudDB.buildLegacyYuedouPatch({
  yuedou: 0,
  yuedouFrozen: 500,
  yuedouSystem: 80,
  score: 75
});
assert.deepStrictEqual(
  zeroBalancePatch,
  {},
  "a real zero balance must not be reset by legacy migration"
);

const missingFieldPatch = cloudDB.buildLegacyYuedouPatch({
  score: 75,
  yuedouFrozen: 500
});
assert.deepStrictEqual(
  missingFieldPatch,
  { yuedou: 10000, yuedouSystem: 0 },
  "legacy migration should only fill missing fields and preserve frozen balance"
);

const settlement = buildSettlementDeltas(
  { openid: "winner", yuedouFrozen: YUEDOU_FROZEN },
  { openid: "loser", yuedouFrozen: YUEDOU_FROZEN }
);

assert.deepStrictEqual(settlement.winner, {
  yuedouDelta: YUEDOU_FROZEN + YUEDOU_WINNER,
  frozenDelta: -YUEDOU_FROZEN,
  systemDelta: YUEDOU_SYSTEM,
  recordAmount: YUEDOU_WINNER
});
assert.deepStrictEqual(settlement.loser, {
  yuedouDelta: 0,
  frozenDelta: -YUEDOU_FROZEN,
  systemDelta: YUEDOU_SYSTEM,
  recordAmount: 0
});

console.log("economy rules tests passed");
