const MATCH_HEADCOUNT_TARGET = 2;

function getSupportedHeadcountTarget(value) {
  const target = value == null ? MATCH_HEADCOUNT_TARGET : Number(value);

  if (!Number.isInteger(target)) {
    throw new Error("人数参数错误");
  }

  if (target < MATCH_HEADCOUNT_TARGET) {
    throw new Error("每局至少需要2人");
  }

  if (target !== MATCH_HEADCOUNT_TARGET) {
    throw new Error("当前仅支持2人对战");
  }

  return MATCH_HEADCOUNT_TARGET;
}

function getUniqueParticipantOpenids(hostOpenid, participants) {
  const openids = [];
  const seen = {};

  [hostOpenid, ...(participants || []).map((p) => p && p.openid)].forEach((openid) => {
    if (!openid || seen[openid]) return;
    seen[openid] = true;
    openids.push(openid);
  });

  return openids;
}

function hasSupportedParticipantSet(hostOpenid, participants) {
  const list = participants || [];
  if (list.length !== MATCH_HEADCOUNT_TARGET) return false;
  if (!list.some((p) => p && p.openid === hostOpenid)) return false;
  return getUniqueParticipantOpenids(hostOpenid, list).length === MATCH_HEADCOUNT_TARGET;
}

module.exports = {
  MATCH_HEADCOUNT_TARGET,
  getSupportedHeadcountTarget,
  getUniqueParticipantOpenids,
  hasSupportedParticipantSet
};
