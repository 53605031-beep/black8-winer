const cloudDB = require("../../utils/cloudDB");

Page({
  data: {
    topThree: [],
    restList: [],
    currentOpenid: ""
  },

  async onLoad() {
    try {
      const lb = await cloudDB.getLeaderboard();
      const openid = cloudDB.getOpenid() || "";
      this.setData({
        topThree: lb.slice(0, 3).map((u, i) => ({ ...u, rank: i + 1 })),
        restList: lb.slice(3).map((u, i) => ({ ...u, rank: i + 4 })),
        currentOpenid: openid
      });
    } catch (e) {
      console.error("加载排行榜失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  }
});
