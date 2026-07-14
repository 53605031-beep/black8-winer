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
  cloudDB.includes('name: "economyService"') && economyService.includes("claimants"),
  "每日礼包必须通过 economyService 的服务端领取记录发放"
);

assert(
  economyService.includes("db.runTransaction"),
  "每日礼包余额、资金池、领取记录必须在同一事务中更新"
);

assert(
  !economyService.includes("ensureDailyPool") &&
    economyService.includes("const poolExists = Boolean(poolRecord.data)") &&
    economyService.includes('transaction.collection("daily_pools").doc(today).set'),
  "每日资金池首次创建必须在领取/兑换事务中完成，不能在事务外覆盖当天记录"
);

assert(
  economyService.includes('parsePositiveInteger(latestGoods.price, "商品价格")') &&
    economyService.includes('parsePositiveInteger(latestGoods.stock, "商品库存")'),
  "兑换必须拒绝零数、负数或小数价格和库存，避免反向增加余额或库存"
);

assert(
  economyService.includes('transaction.collection("daily_pools").doc(today).get()') &&
    matchService.includes('transaction.collection("matches").doc(matchId).get()'),
  "云函数事务内读写必须使用兼容的 transaction.collection API"
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
  matchService.includes('addScoreRecord(settlement.winnerId, "match_win", YUEDOU_WINNER'),
  "约豆记录必须记录赢家实际到账约豆，避免福利站余额被截断"
);

assert(
  matchService.includes("!startedAt || Date.now() - startedAt <= 6 * 3600000"),
  "进行中球局缺少合法 startedAt 时不能被强制关闭退款"
);

assert(
  matchService.includes("async function doConfirm") &&
    matchService.includes('await db.runTransaction(async (transaction) =>') &&
    matchService.includes('const matchRes = await transaction.collection("matches").doc(matchId).get()') &&
    matchService.includes('await transaction.collection("matches").doc(matchId).update'),
  "确认开始必须在事务内重新读取球局，避免和退出并发导致单人 playing 球局"
);

assert(
  matchService.includes('const host = updated.find((p) => p.openid === match.hostOpenid)') &&
    matchService.includes('const hostChoice = choices[match.hostOpenid] || ""') &&
    !matchService.includes("const hostChoice = choices[0]"),
  "结算必须按 hostOpenid 判断发起人结果，不能依赖 participants 数组顺序"
);

assert(
  matchService.includes('if (!user) throw new Error("参与者用户数据不存在，无法自动退款")') &&
    !matchService.includes("if (!user) continue"),
  "退款找不到用户时必须保留球局冻结记录并失败，不能静默跳过"
);

assert(
  matchService.includes('if (!user) throw new Error("用户数据不存在，无法自动退款")') &&
    !matchService.includes("if (user) {"),
  "普通参与者退出时找不到用户也必须失败，不能先移除参与人再跳过退款"
);

assert(
  matchService.includes("参与者冻结约豆数据异常，无法自动退款") &&
    matchService.includes("用户冻结约豆数据异常，不能结算"),
  "退款和结算必须核对账户冻结余额，不能把历史脏数据扣成负数"
);

assert(
  matchService.includes('transaction.collection("matches").doc(matchId).get()') &&
    matchService.includes('transaction.collection("matches").doc(matchId).update') &&
    matchService.includes('db.collection("venues").doc(match.venueId).get()') &&
    !matchService.includes("maxDistanceKm"),
  "位置校验必须事务合并最新参与人，并使用服务端球房坐标和固定距离"
);

assert(
  !cloudDB.includes('data: { participants: updatedParticipants }'),
  "客户端更新资料不能重写整份 participants 数组，避免覆盖服务端结算状态"
);

assert(
  cloudDB.includes("自动关闭过期球局失败") &&
    cloudDB.includes("active.push(m);") &&
    !cloudDB.includes("closeMatch(m._id, openid).catch(() => {})"),
  "自动关闭过期球局失败时仍要显示活跃球局，避免冻结约豆被隐藏"
);

console.log("economy rules checks passed");
