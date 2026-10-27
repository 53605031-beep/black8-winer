function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function formatDateTime(ts) {
  const d = new Date(ts);
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${mm}-${dd} ${hh}:${mi}`;
}

function playTypeLabel(playType) {
  switch (playType) {
    case "eight_ball": return "八球";
    case "nine_ball":  return "九球";
    case "snooker":    return "斯诺克";
    case "practice":  return "练球";
    case "casual":    return "娱乐";
    default:          return "未知";
  }
}

function skillLabel(skill) {
  switch (skill) {
    case "any":         return "不限";
    case "beginner":    return "新手";
    case "intermediate":return "进阶";
    case "advanced":   return "高手";
    default:            return "未知";
  }
}

function costModeLabel(costMode) {
  switch (costMode) {
    case "aa":           return "AA";
    case "host_treats":  return "我请";
    case "guest_treats": return "你请";
    case "venue_promo":  return "球房活动";
    default:             return "未知";
  }
}

function scoreDeltaLabel(delta) {
  if (delta === 0) return "±0";
  return delta > 0 ? `+${delta}` : String(delta);
}

/**
 * 默认开局时刻：从现在起大约 30～60 分钟，并对齐到 30 分钟一档。
 * 算过了午夜就落到第二天，不能再把时钟折回“今天 00:00”（那是已经过去的时间）。
 * @param {Date} now
 * @returns {{ dayOffset: number, time: string }}
 */
function defaultStartSlot(now = new Date()) {
  const curMins = now.getHours() * 60 + now.getMinutes();
  const rounded = Math.ceil((curMins + 30) / 30) * 30;
  const dayOffset = rounded >= 24 * 60 ? 1 : 0;
  const mins = rounded % (24 * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return { dayOffset, time: `${pad2(h)}:${pad2(m)}` };
}

/**
 * 用年月日和 HH:MM 拼开局时间戳（按手机本地时区）。
 * 不用 Date 解析 "YYYY-MM-DDTHH:mm" 字符串，避免部分机型得到非法时间。
 * @returns {number} 毫秒时间戳；拼不出来时返回 NaN
 */
function buildStartTimestamp(date, time) {
  if (!date || !time) return NaN;
  const dateParts = String(date).split("-").map(Number);
  const timeParts = String(time).split(":").map(Number);
  if (dateParts.length < 3 || timeParts.length < 2) return NaN;
  const [yyyy, mm, dd] = dateParts;
  const [hh, mi] = timeParts;
  if (![yyyy, mm, dd, hh, mi].every((n) => Number.isFinite(n))) return NaN;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh < 0 || hh > 23 || mi < 0 || mi > 59) return NaN;
  return new Date(yyyy, mm - 1, dd, hh, mi, 0, 0).getTime();
}

module.exports = {
  formatDateTime,
  playTypeLabel,
  skillLabel,
  costModeLabel,
  scoreDeltaLabel,
  defaultStartSlot,
  buildStartTimestamp
};
