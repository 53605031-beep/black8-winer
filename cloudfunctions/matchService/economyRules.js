const YUEDOU_INITIAL = 10000;
const YUEDOU_FROZEN = 500;
const YUEDOU_WINNER = 420;
const YUEDOU_SYSTEM = 80;

function getFrozenAmount(participant) {
  const amount = Number(participant && participant.yuedouFrozen);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function getDistinctParticipants(participants) {
  const seen = {};
  const list = [];
  (participants || []).forEach((p) => {
    if (!p || !p.openid || seen[p.openid]) return;
    seen[p.openid] = true;
    list.push(p);
  });
  return list;
}

function buildFinalParticipants(participants) {
  return (participants || []).map((p) => ({
    ...p,
    yuedouFrozen: 0
  }));
}

function buildSettlement(match, participants) {
  const activeParticipants = getDistinctParticipants(participants);
  if (activeParticipants.length !== 2) {
    throw new Error("当前只支持两人球局结算");
  }

  const host = activeParticipants.find((p) => p.openid === match.hostOpenid);
  const joiner = activeParticipants.find((p) => p.openid !== match.hostOpenid);
  if (!host || !joiner) {
    throw new Error("结算参与者信息异常");
  }

  const hostChoice = host.resultChoice || "";
  const joinChoice = joiner.resultChoice || "";
  const hostWins = hostChoice === "win" && joinChoice === "lose";
  const joinerWins = hostChoice === "lose" && joinChoice === "win";
  if (!hostWins && !joinerWins) {
    return { consistent: false };
  }

  const winner = hostWins ? host : joiner;
  const loser = hostWins ? joiner : host;
  const winnerFrozen = getFrozenAmount(winner);
  const loserFrozen = getFrozenAmount(loser);

  return {
    consistent: true,
    winnerId: winner.openid,
    loserId: loser.openid,
    winnerFrozen,
    loserFrozen,
    winnerLiquidDelta: winnerFrozen + YUEDOU_WINNER,
    loserLiquidDelta: 0,
    winnerFrozenDelta: -winnerFrozen,
    loserFrozenDelta: -loserFrozen,
    systemAmount: YUEDOU_SYSTEM,
    scoreRecordAmount: YUEDOU_WINNER
  };
}

module.exports = {
  YUEDOU_INITIAL,
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_SYSTEM,
  getFrozenAmount,
  getDistinctParticipants,
  buildFinalParticipants,
  buildSettlement
};
