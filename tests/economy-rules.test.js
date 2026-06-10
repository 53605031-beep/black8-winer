const assert = require("assert");
const Module = require("module");

function loadMatchServiceWithMockCloud() {
  const originalLoad = Module._load;
  const mockDb = {
    command: {
      inc: (value) => ({ op: "inc", value }),
      push: (value) => ({ op: "push", value }),
      pull: (value) => ({ op: "pull", value })
    },
    collection() {
      return {
        where() { return this; },
        doc() { return this; },
        get: async () => ({ data: [] }),
        update: async () => ({}),
        add: async () => ({}),
        remove: async () => ({})
      };
    },
    serverDate: () => new Date(0)
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return {
        DYNAMIC_CURRENT_ENV: "test",
        init() {},
        database: () => mockDb,
        getWXContext: () => ({ OPENID: "test-openid" })
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../cloudfunctions/matchService/index.js");
  } finally {
    Module._load = originalLoad;
  }
}

function applyDelta(balance, delta) {
  return {
    yuedou: balance.yuedou + delta.yuedou,
    yuedouFrozen: balance.yuedouFrozen + delta.yuedouFrozen,
    yuedouSystem: balance.yuedouSystem + delta.yuedouSystem
  };
}

const matchService = loadMatchServiceWithMockCloud();
const { buildSettlementDeltas } = matchService.__test__;

assert.strictEqual(typeof buildSettlementDeltas, "function");

{
  const participants = [
    { openid: "winner", yuedouFrozen: 500 },
    { openid: "loser", yuedouFrozen: 500 }
  ];
  const deltas = buildSettlementDeltas(participants, "winner", "loser");

  assert.deepStrictEqual(deltas.winner, {
    yuedou: 920,
    yuedouFrozen: -500,
    yuedouSystem: 0
  });
  assert.deepStrictEqual(deltas.loser, {
    yuedou: 0,
    yuedouFrozen: -500,
    yuedouSystem: 80
  });

  const afterFreeze = { yuedou: 9500, yuedouFrozen: 500, yuedouSystem: 0 };
  assert.deepStrictEqual(applyDelta(afterFreeze, deltas.winner), {
    yuedou: 10420,
    yuedouFrozen: 0,
    yuedouSystem: 0
  });
  assert.deepStrictEqual(applyDelta(afterFreeze, deltas.loser), {
    yuedou: 9500,
    yuedouFrozen: 0,
    yuedouSystem: 80
  });
}

{
  const participants = [
    { openid: "winner", yuedouFrozen: 300 },
    { openid: "loser", yuedouFrozen: 300 }
  ];
  const deltas = buildSettlementDeltas(participants, "winner", "loser");

  assert.strictEqual(deltas.winner.yuedou, 720);
  assert.strictEqual(deltas.winner.yuedouFrozen, -300);
  assert.strictEqual(deltas.loser.yuedou, 0);
  assert.strictEqual(deltas.loser.yuedouFrozen, -300);
}

console.log("economy rules ok");
