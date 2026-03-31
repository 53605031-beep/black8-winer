const cloudDB = require("../../utils/cloudDB");

Page({
  data: {
    records: [],
    loading: true,
    empty: false
  },

  onLoad() {
    this._load();
  },

  async _load() {
    this.setData({ loading: true });
    try {
      const records = await cloudDB.getMyScoreRecords(50);
      const formatted = records.map(r => ({
        ...r,
        typeLabel: _typeLabel(r.type),
        amountText: r.amount > 0 ? `+${r.amount}` : `${r.amount}`,
        amountClass: r.amount > 0 ? "gain" : "spend",
        dateText: _formatDate(r.createdAt)
      }));
      this.setData({ records: formatted, empty: records.length === 0 });
    } catch (e) {
      console.error("加载约豆明细失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onPullDownRefresh() {
    this._load().finally(() => wx.stopPullDownRefresh());
  }
});

function _typeLabel(type) {
  const map = {
    match_win: "比赛获胜",
    match_lose: "比赛失败",
    daily_gift: "每日礼包",
    daily_bonus: "每日礼包",
    exchange: "兑换商品"
  };
  return map[type] || type || "其他";
}

function _formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${min}`;
}
