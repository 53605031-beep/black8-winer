const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const cloudDB = read("utils/cloudDB.js");
const matchService = read("cloudfunctions/matchService/index.js");
const economyService = read("cloudfunctions/economyService/index.js");
const mallManage = read("cloudfunctions/mallManage/index.js");
const venueDetail = read("pages/venue-detail/index.js");
const adminGoods = read("pages/admin-goods/index.js");

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

assert(
  cloudDB.includes('name: "economyService"') && economyService.includes('action === "redeemGoods"'),
  "商城兑换必须通过 economyService 服务端事务扣款和扣库存"
);

assert(
  economyService.includes("mall_daily_redemptions") && economyService.includes("MAX_DAILY_REDEMPTIONS"),
  "商城兑换每日次数限制必须使用服务端幂等计数"
);

assert(
  cloudDB.includes('name: "mallManage"') && mallManage.includes("cloud.getWXContext()"),
  "商品后台读写必须通过 mallManage 用云端 OPENID 鉴权"
);

assert(
  !adminGoods.includes('wx.getStorageSync("openid")'),
  "商品后台页面不能用本地缓存 openid 判断管理员权限"
);

console.log("economy rules checks passed");
