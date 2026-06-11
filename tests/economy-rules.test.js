const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const matchService = read("cloudfunctions/matchService/index.js");
const cloudDB = read("utils/cloudDB.js");
const venueDetail = read("pages/venue-detail/index.js");
const economyService = read("cloudfunctions/economyService/index.js");

assert(
  matchService.includes("winnerFrozen + YUEDOU_WINNER"),
  "winner must receive their frozen stake back plus the win reward"
);
assert(
  matchService.includes("yuedouFrozen: _.inc(-loserFrozen)") &&
    !matchService.includes("yuedou: _.inc(YUEDOU_LOSER)"),
  "loser must only consume the already-frozen stake, not lose liquid yuedou again"
);
assert(
  matchService.includes('if (["playing", "settled", "finished"].includes(match.status))') &&
    matchService.includes("不能退出"),
  "host and participant leave must be blocked after a match starts"
);
assert(
  matchService.includes("participants.length !== 2") &&
    matchService.includes("当前仅支持2人局满员后开始"),
  "server must reject non-full or non-two-player match starts"
);
assert(
  cloudDB.includes('data: { action: "close", matchId }') &&
    !cloudDB.includes('data: { status: "cancelled", closedAt: db.serverDate(), closedBy: openid }'),
  "closeMatch must route through matchService instead of refunding from the client"
);
assert(
  cloudDB.includes("const needsFix = u.yuedou == null;"),
  "zero yuedou is a valid balance and must not be migrated to the initial balance"
);
assert(
  cloudDB.includes('name: "economyService"') &&
    economyService.includes("daily_bonus_claims") &&
    economyService.includes("db.runTransaction"),
  "daily bonus claims must run through the economyService transaction"
);
assert(
  venueDetail.includes("cancelMatchByVenueOwner(match._id)") &&
    !venueDetail.includes('data: { status: "cancelled" }'),
  "venue-owner cancellation must use the server refund path"
);

console.log("economy rules ok");
