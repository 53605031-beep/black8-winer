Page({
  data: {
    tab: "agreement"
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: "用户协议" });
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    wx.setNavigationBarTitle({ title: tab === "agreement" ? "用户协议" : "隐私政策" });
  }
});
