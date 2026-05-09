const assert = require("assert");
const {
  MATCH_HEADCOUNT_TARGET,
  getSupportedHeadcountTarget,
  getUniqueParticipantOpenids,
  hasSupportedParticipantSet
} = require("./matchRules");

function assertThrowsMessage(fn, message) {
  assert.throws(fn, (err) => err && err.message === message);
}

assert.strictEqual(MATCH_HEADCOUNT_TARGET, 2);
assert.strictEqual(getSupportedHeadcountTarget(undefined), 2);
assert.strictEqual(getSupportedHeadcountTarget(null), 2);
assert.strictEqual(getSupportedHeadcountTarget(2), 2);
assert.strictEqual(getSupportedHeadcountTarget("2"), 2);
assertThrowsMessage(() => getSupportedHeadcountTarget(1), "每局至少需要2人");
assertThrowsMessage(() => getSupportedHeadcountTarget(3), "当前仅支持2人对战");
assertThrowsMessage(() => getSupportedHeadcountTarget("abc"), "人数参数错误");

assert.deepStrictEqual(
  getUniqueParticipantOpenids("host", [
    { openid: "host" },
    { openid: "joiner" },
    { openid: "joiner" }
  ]),
  ["host", "joiner"]
);

assert.strictEqual(
  hasSupportedParticipantSet("host", [{ openid: "host" }, { openid: "joiner" }]),
  true
);
assert.strictEqual(
  hasSupportedParticipantSet("host", [{ openid: "host" }, { openid: "host" }]),
  false
);
assert.strictEqual(
  hasSupportedParticipantSet("host", [{ openid: "joiner1" }, { openid: "joiner2" }]),
  false
);
assert.strictEqual(
  hasSupportedParticipantSet("host", [{ openid: "host" }, { openid: "joiner1" }, { openid: "joiner2" }]),
  false
);

console.log("matchRules tests passed");
