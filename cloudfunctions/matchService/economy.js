const YUEDOU_FROZEN = 500;
const YUEDOU_WINNER = 420;
const YUEDOU_SYSTEM = 80;

function getParticipantStake(participant) {
  const stake = Number(participant && participant.yuedouFrozen);
  return Number.isFinite(stake) && stake > 0 ? stake : 0;
}

function getUniqueOpenids(participants) {
  const seen = new Set();
  const result = [];
  (participants || []).forEach((p) => {
    if (!p || !p.openid || seen.has(p.openid)) return;
    seen.add(p.openid);
    result.push(p.openid);
  });
  return result;
}

function assertTwoPlayerMatch(match, participants) {
  const list = participants || [];
  const target = match.headcountTarget || 2;
  const openids = getUniqueOpenids(list);
  if (target !== 2 || list.length !== 2 || openids.length !== 2) {
    throw new Error("当前只支持两人球局结算");
  }
  if (!openids.includes(match.hostOpenid)) {
    throw new Error("球局发起人不在参与名单中");
  }
}

function buildSettlement(match, participants) {
  assertTwoPlayerMatch(match, participants);

  const host = participants.find((p) => p.openid === match.hostOpenid);
  const joiner = participants.find((p) => p.openid !== match.hostOpenid);
  const hostChoice = host && host.resultChoice;
  const joinChoice = joiner && joiner.resultChoice;

  const isHostWin = hostChoice === "win" && joinChoice === "lose";
  const isJoinerWin = hostChoice === "lose" && joinChoice === "win";
  if (!isHostWin && !isJoinerWin) {
    return null;
  }

  const winner = isHostWin ? host : joiner;
  const loser = isHostWin ? joiner : host;
  const winnerStake = getParticipantStake(winner);
  const loserStake = getParticipantStake(loser);

  return {
    winnerId: winner.openid,
    loserId: loser.openid,
    winnerStake,
    loserStake,
    winnerGain: winnerStake + YUEDOU_WINNER,
    loserGain: 0,
    systemGain: YUEDOU_SYSTEM
  };
}

function isValidStartedAt(startedAt) {
  if (!startedAt) return false;
  const time = new Date(startedAt).getTime();
  return Number.isFinite(time);
}

function canForceClosePlaying(startedAt, now = Date.now()) {
  if (!isValidStartedAt(startedAt)) return false;
  return now - new Date(startedAt).getTime() > 6 * 60 * 60 * 1000;
}

module.exports = {
  YUEDOU_FROZEN,
  YUEDOU_WINNER,
  YUEDOU_SYSTEM,
  getParticipantStake,
  getUniqueOpenids,
  assertTwoPlayerMatch,
  buildSettlement,
  isValidStartedAt,
  canForceClosePlaying
};
