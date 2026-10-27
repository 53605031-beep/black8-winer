const assert = require("assert");
const { defaultStartSlot, buildStartTimestamp } = require("../utils/format");

function at(hour, minute, second = 30) {
  return new Date(2026, 9, 27, hour, minute, second);
}

function slotMoment(now, slot) {
  const [hour, minute] = slot.time.split(":").map(Number);
  return new Date(2026, 9, 27 + slot.dayOffset, hour, minute, 0, 0);
}

// 一天里的每一分钟，默认开局时间都必须落在“现在”之后，并且不超过 1 小时。
for (let mins = 0; mins < 24 * 60; mins++) {
  const now = at(Math.floor(mins / 60), mins % 60);
  const slot = defaultStartSlot(now);
  const when = slotMoment(now, slot);
  assert.ok(when.getTime() > now.getTime(), `默认时间不是未来：${now.toTimeString()} -> ${slot.dayOffset} ${slot.time}`);
  assert.ok(when.getTime() - now.getTime() <= 60 * 60 * 1000, `默认时间太远：${now.toTimeString()} -> ${slot.time}`);
}

assert.deepStrictEqual(defaultStartSlot(at(22, 31)), { dayOffset: 0, time: "23:30" });
assert.deepStrictEqual(defaultStartSlot(at(23, 0)), { dayOffset: 0, time: "23:30" });
assert.deepStrictEqual(defaultStartSlot(at(23, 1)), { dayOffset: 1, time: "00:00" });
assert.deepStrictEqual(defaultStartSlot(at(23, 30)), { dayOffset: 1, time: "00:00" });
assert.deepStrictEqual(defaultStartSlot(at(23, 31)), { dayOffset: 1, time: "00:30" });
assert.deepStrictEqual(defaultStartSlot(at(23, 59)), { dayOffset: 1, time: "00:30" });

const ts = buildStartTimestamp("2026-10-27", "23:30");
assert.strictEqual(ts, new Date(2026, 9, 27, 23, 30, 0, 0).getTime());
assert.ok(Number.isFinite(ts));
assert.ok(!Number.isFinite(buildStartTimestamp("", "10:00")));
assert.ok(!Number.isFinite(buildStartTimestamp("2026-10-27", "")));
assert.ok(!Number.isFinite(buildStartTimestamp("2026-10-27", "24:00")));
assert.ok(!Number.isFinite(buildStartTimestamp("bad", "10:00")));

// 旧算法把越过午夜的分钟用 % 1440 折回当天，23:01 会得到今天 00:00，比现在早大约 23 小时。
const late = at(23, 1);
const oldRounded = Math.ceil((late.getHours() * 60 + late.getMinutes() + 30) / 30) * 30;
const oldHour = Math.floor((oldRounded % 1440) / 60);
const oldMinute = oldRounded % 60;
const oldMoment = new Date(2026, 9, 27, oldHour, oldMinute, 0, 0);
assert.ok(oldMoment.getTime() < late.getTime());
assert.ok(slotMoment(late, defaultStartSlot(late)).getTime() > late.getTime());

console.log("publish-time tests passed");
