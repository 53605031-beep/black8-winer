const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const cloudDB = read("utils/cloudDB.js");
const matchService = read("cloudfunctions/matchService/index.js");
const economyService = read("cloudfunctions/economyService/index.js");
const venueDetail = read("pages/venue-detail/index.js");

assert(
  !cloudDB.includes("u.yuedou === 0"),
  "真实 0 约豆余额不能触发老用户初始化"
);

assert(
  cloudDB.includes('name: "economyService"') && economyService.includes("daily_claims"),
  "每日礼包必须通过 economyService 的幂等领取记录发放"
);

assert(
  economyService.includes("db.runTransaction"),
  "每日礼包余额、资金池、领取记录必须在同一事务中更新"
);

assert(
  !venueDetail.includes('collection("matches").doc(match._id).update'),
  "商家取消球局不能直接改 matches.status"
);

assert(
  venueDetail.includes("cancelMatchByVenueOwner"),
  "商家取消球局必须走 matchService 统一退款入口"
);

assert(
  matchService.includes("case \"close\"") && matchService.includes("case \"cancelByVenueOwner\""),
  "关闭/商家取消球局必须由 matchService 服务端处理"
);

assert(
  !matchService.includes('doc(matchId).remove()'),
  "发起人退出不能删除球局后再尝试退款"
);

assert(
  !matchService.includes("yuedou: _.inc(YUEDOU_LOSER)"),
  "输家冻结约豆已在加入时扣除，结算时不能再次扣液态约豆"
);

assert(
  !cloudDB.includes("db.command.inc(-YUEDOU_LOSER)"),
  "客户端工具层不能保留旧的输家二次扣款结算逻辑"
);

console.log("economy rules checks passed");
