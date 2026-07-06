const YUEDOU_FROZEN = 500;
const YUEDOU_WINNER = 420;
const YUEDOU_SYSTEM = 80;

function getFrozenAmount(participant) {
  const frozen = Number(participant && participant.yuedouFrozen);
  return Number.isFinite(frozen) && frozen > 0 ? frozen : YUEDOU_FROZEN;
}

/**
 * 计算一场两人球局的约豆结算变化。
 * 参加时已经从余额扣掉并冻结 500 约豆，所以结算时只退回赢家本场冻结额，
 * 再给赢家加 420；输家不再从余额二次扣钱，只清掉本场冻结额。
 */
function buildSettlementDeltas(match, participants) {
  const list = Array.isArray(participants) ? participants : [];
  const openids = [...new Set(list.map((p) => p && p.openid).filter(Boolean))];

  if (!match || !match.hostOpenid) throw new Error("球局缺少发起人");
  if (openids.length !== 2) throw new Error("当前只支持两人球局结算");

  const byOpenid = {};
  list.forEach((p) => {
    if (p && p.openid) byOpenid[p.openid] = p;
  });

  const host = byOpenid[match.hostOpenid];
  const joinOpenid = openids.find((openid) => openid !== match.hostOpenid);
  const joiner = byOpenid[joinOpenid];
  if (!host || !joiner) throw new Error("结算参与人不完整");

  let winnerId = null;
  let loserId = null;
  if (host.resultChoice === "win" && joiner.resultChoice === "lose") {
    winnerId = host.openid;
    loserId = joiner.openid;
  } else if (host.resultChoice === "lose" && joiner.resultChoice === "win") {
    winnerId = joiner.openid;
    loserId = host.openid;
  } else {
    throw new Error("双方结果不一致，无法结算");
  }

  const winner = byOpenid[winnerId];
  const loser = byOpenid[loserId];
  const winnerFrozen = getFrozenAmount(winner);
  const loserFrozen = getFrozenAmount(loser);

  return {
    winnerId,
    loserId,
    winnerFrozen,
    loserFrozen,
    winnerYuedouDelta: winnerFrozen + YUEDOU_WINNER,
    loserYuedouDelta: 0,
    winnerFrozenDelta: -winnerFrozen,
    loserFrozenDelta: -loserFrozen,
    recordAmount: YUEDOU_WINNER,
    systemDelta: YUEDOU_SYSTEM
  };
}

module.exports = {
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_SYSTEM,
  buildSettlementDeltas
};
