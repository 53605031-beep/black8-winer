const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "wx-server-sdk") {
    return {
      DYNAMIC_CURRENT_ENV: "test",
      init() {},
      getWXContext() { return { OPENID: "test-openid" }; },
      database() {
        return {
          command: {
            inc(value) { return { $inc: value }; },
            push(value) { return { $push: value }; }
          }
        };
      }
    };
  }
  return originalLoad(request, parent, isMain);
};

const cloudDB = require("../utils/cloudDB");
const matchService = require("../cloudfunctions/matchService/index.js");
Module._load = originalLoad;

const { buildYuedouMigrationFix } = cloudDB.__test;
const {
  buildFrozenRefunds,
  clearParticipantFrozen,
  getUniqueParticipantOpenids,
  buildSettlementPlan,
  canForceClosePlaying,
  PLAYING_CLOSE_AFTER_MS
} = matchService.__test;

assert.deepStrictEqual(
  buildYuedouMigrationFix({ yuedou: 0, yuedouFrozen: 500, yuedouSystem: 80, score: 99 }),
  {},
  "0 约豆是真实余额，不能被迁移逻辑充值"
);

assert.deepStrictEqual(
  buildYuedouMigrationFix({ score: 99 }),
  { yuedou: 10000, yuedouFrozen: 0, yuedouSystem: 0 },
  "老用户只在字段缺失时补初始约豆字段"
);

const match = {
  hostOpenid: "host",
  participants: [
    { openid: "host", yuedouFrozen: 500 },
    { openid: "joiner", yuedouFrozen: 500 }
  ]
};

assert.deepStrictEqual(
  buildFrozenRefunds(match),
  [
    { openid: "host", amount: 500 },
    { openid: "joiner", amount: 500 }
  ],
  "退款只按本场参与者冻结快照计算"
);

assert.deepStrictEqual(
  buildFrozenRefunds({
    participants: [
      { openid: "same-user", yuedouFrozen: 300 },
      { openid: "same-user", yuedouFrozen: 200 },
      { openid: "other-user", yuedouFrozen: 0 }
    ]
  }),
  [{ openid: "same-user", amount: 500 }],
  "重复参与者快照按 openid 汇总，0 冻结不退款"
);

assert.deepStrictEqual(
  clearParticipantFrozen(match.participants),
  [
    { openid: "host", yuedouFrozen: 0 },
    { openid: "joiner", yuedouFrozen: 0 }
  ],
  "取消或结算后要清掉本场冻结快照，防止重复退款"
);

assert.deepStrictEqual(
  getUniqueParticipantOpenids({
    hostOpenid: "host",
    participants: [{ openid: "host" }, { openid: "joiner" }, { openid: "joiner" }]
  }),
  ["host", "joiner"],
  "活跃积分发放前要按 openid 去重"
);

assert.deepStrictEqual(
  buildSettlementPlan(
    { hostOpenid: "host" },
    [
      { openid: "host", yuedouFrozen: 500, resultChoice: "win" },
      { openid: "joiner", yuedouFrozen: 500, resultChoice: "lose" }
    ]
  ),
  {
    winnerId: "host",
    loserId: "joiner",
    winnerFrozen: 500,
    loserFrozen: 500,
    winnerYuedouInc: 920,
    winnerFrozenInc: -500,
    loserYuedouInc: 0,
    loserFrozenInc: -500,
    loserSystemInc: 80
  },
  "赢家拿回自己冻结的 500 并获得 420，输家不再额外扣可用余额"
);

assert.throws(
  () => buildSettlementPlan(
    { hostOpenid: "host" },
    [
      { openid: "host", yuedouFrozen: 500, resultChoice: "win" },
      { openid: "joiner", yuedouFrozen: 500, resultChoice: "win" }
    ]
  ),
  /比赛结果不一致/,
  "双方结果冲突时不能结算"
);

const now = Date.now();
assert.strictEqual(
  canForceClosePlaying({ startedAt: new Date(now - PLAYING_CLOSE_AFTER_MS + 1000) }, now),
  false,
  "进行中未满6小时不能通过云函数强制关闭"
);
assert.strictEqual(
  canForceClosePlaying({ startedAt: new Date(now - PLAYING_CLOSE_AFTER_MS - 1000) }, now),
  true,
  "进行中超过6小时后才能通过云函数强制关闭"
);
assert.strictEqual(
  canForceClosePlaying({}, now),
  true,
  "没有 startedAt 的老数据按页面原策略允许关闭"
);

console.log("economy rules tests passed");
