const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;

Module._load = function mockedLoad(request, parent, isMain) {
  if (request === "wx-server-sdk") {
    const db = {
      command: {},
      collection() {
        throw new Error("Database should not be touched by helper tests");
      },
      serverDate() {
        return new Date();
      }
    };

    return {
      DYNAMIC_CURRENT_ENV: "test",
      init() {},
      database() {
        return db;
      },
      getWXContext() {
        return { OPENID: "test-openid" };
      }
    };
  }

  return originalLoad(request, parent, isMain);
};

try {
  const matchService = require("../cloudfunctions/matchService/index.js");
  const { getUniqueParticipantOpenids } = matchService._private;

  assert.deepStrictEqual(
    getUniqueParticipantOpenids({
      hostOpenid: "host-openid",
      participants: [
        { openid: "host-openid" },
        { openid: "joiner-openid" }
      ]
    }),
    ["host-openid", "joiner-openid"]
  );

  assert.deepStrictEqual(
    getUniqueParticipantOpenids({
      hostOpenid: "host-openid",
      participants: [
        { openid: "joiner-openid" },
        { openid: "host-openid" },
        { openid: "joiner-openid" },
        { openid: "" },
        {}
      ]
    }),
    ["host-openid", "joiner-openid"]
  );
} finally {
  Module._load = originalLoad;
}
