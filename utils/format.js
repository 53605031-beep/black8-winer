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

module.exports = {
  formatDateTime,
  playTypeLabel,
  skillLabel,
  costModeLabel,
  scoreDeltaLabel
};
