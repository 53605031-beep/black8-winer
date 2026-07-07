const YUEDOU_INITIAL = 10000;

function buildMissingYuedouUpdate(user) {
  const update = {};
  if (!user || user.yuedou == null) update.yuedou = YUEDOU_INITIAL;
  if (!user || user.yuedouFrozen == null) update.yuedouFrozen = 0;
  if (!user || user.yuedouSystem == null) update.yuedouSystem = 0;
  return update;
}

module.exports = {
  YUEDOU_INITIAL,
  buildMissingYuedouUpdate
};
