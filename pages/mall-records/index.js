const cloudDB = require("../../utils/cloudDB");

Page({
  data: {
    records: [],
    loading: true
  },

  onShow() {
    this._load();
  },

  onPullDownRefresh() {
    this._load().finally(() => wx.stopPullDownRefresh());
  },

  async _load() {
    this.setData({ loading: true });
    try {
      const records = await cloudDB.getMyRedemptions();
      this.setData({ records });
    } catch (e) {
      console.error("加载兑换记录失败", e);
    } finally {
      this.setData({ loading: false });
    }
  },

  getStatusText(status) {
    const map = {
      pending: "待发货",
      shipped: "已发货",
      completed: "已完成",
      cancelled: "已取消"
    };
    return map[status] || status;
  },

  getStatusClass(status) {
    const map = {
      pending: "wait",
      shipped: "shipped",
      completed: "ok",
      cancelled: "cancelled"
    };
    return map[status] || "wait";
  },

  formatDate(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
});
