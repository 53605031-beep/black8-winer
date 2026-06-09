const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "wx-server-sdk") {
    return {
      DYNAMIC_CURRENT_ENV: "test",
      init() {},
      getWXContext() {
        return { OPENID: "tester" };
      },
      database() {
        return {
          command: {
            inc(value) {
              return { $inc: value };
            },
            push(value) {
              return { $push: value };
            },
            gte(value) {
              return { $gte: value };
            }
          },
          collection() {
            return {};
          },
          serverDate() {
            return new Date("2026-01-01T00:00:00Z");
          }
        };
      }
    };
  }
  return originalLoad(request, parent, isMain);
};

const rules = require("../cloudfunctions/matchService/index.js").__test__;
const economyRules = require("../cloudfunctions/economyService/index.js").__test__;
Module._load = originalLoad;

const participants = [
  { openid: "host", nickname: "Host", resultChoice: "win", yuedouFrozen: 500 },
  { openid: "guest", nickname: "Guest", resultChoice: "lose", yuedouFrozen: 500 },
  { openid: "host", nickname: "Duplicate Host", resultChoice: "win", yuedouFrozen: 500 }
];

assert.deepStrictEqual(
  rules.dedupeParticipants(participants).map((p) => p.openid),
  ["host", "guest"],
  "host must not be counted twice when host is also in participants"
);

const settlement = rules.buildSettlement(
  { hostOpenid: "host", headcountTarget: 2 },
  participants
);

assert.strictEqual(settlement.consistent, true);
assert.strictEqual(settlement.winner.openid, "host");
assert.strictEqual(settlement.loser.openid, "guest");

const initial = 10000;
const afterFreeze = initial - rules.YUEDOU_FROZEN;
const winnerFinal = afterFreeze + rules.getFrozenAmount(settlement.winner) + rules.YUEDOU_WINNER;
const loserFinal = afterFreeze;

assert.strictEqual(winnerFinal, 10420, "winner should net +420 after their frozen stake is returned");
assert.strictEqual(loserFinal, 9500, "loser should only lose the already-frozen 500 stake");

const cloudDBSource = fs.readFileSync(path.join(__dirname, "../utils/cloudDB.js"), "utf8");
assert(
  !cloudDBSource.includes("u.yuedou === 0"),
  "real zero yuedou balances must not be migrated back to the initial grant"
);
assert(
  !cloudDBSource.includes("runTransaction"),
  "mini program client code must not call cloud database transactions directly"
);
assert(
  !cloudDBSource.includes("daily_pools\").add"),
  "daily bonus pool creation must happen in the economyService transaction"
);
assert.strictEqual(
  economyRules.buildDailyClaimId("2026-06-09", "openid-1"),
  "2026-06-09_openid-1",
  "daily bonus must use a stable per-user per-day claim document"
);

console.log("economy rules ok");
