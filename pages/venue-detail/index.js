const cloudDB = require("../../utils/cloudDB");
const { formatDateTime, playTypeLabel, costModeLabel } = require("../../utils/format");

Page({
  data: {
    venue: null,
    venueMatches: [],
    isOwner: false
  },

  async onLoad(query) {
    const venueId = query.venueId || null;
    if (!venueId) {
      wx.showToast({ title: "参数错误", icon: "none" });
      return;
    }

    try {
      const v = await cloudDB.getVenueById(venueId);
      if (!v) {
        wx.showToast({ title: "球房不存在", icon: "none" });
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }

      // 检查当前用户是否为该球房的商家（拥有者）
      const myOpenid = cloudDB.getOpenid();
      const isOwner = v.ownerOpenid === myOpenid;

      const rawMatches = await cloudDB.getMatchesByVenue(venueId);
      const venueMatches = rawMatches.map((m) => ({
        ...m,
        startAtText: formatDateTime(m.startAt),
        playTypeText: playTypeLabel(m.playType),
        costModeText: costModeLabel(m.costMode || "aa"),
        hostNickname: m.hostNickname || m.host?.nickname || "球友"
      }));

      this.setData({ venue: v, venueMatches, isOwner });
    } catch (e) {
      console.error("加载球房详情失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  onPublishFromVenue() {
    const venueId = this.data.venue._id || this.data.venue.venueId;
    wx.setStorageSync("draft.match.venueId", venueId);
    wx.switchTab({ url: "/pages/publish/index" });
  },

  onNav() {
    const venue = this.data.venue;
    if (venue.location && venue.location.latitude) {
      wx.openLocation({
        latitude: venue.location.latitude,
        longitude: venue.location.longitude,
        name: venue.name,
        address: venue.address
      });
    } else {
      wx.showModal({
        title: "导航到店",
        content: `地址：${venue.address}\n\n请手动复制后在地图中搜索`,
        showCancel: false
      });
    }
  },

  onOpenMatch(e) {
    const matchId = e.currentTarget.dataset.matchId;
    wx.navigateTo({ url: `/pages/match-detail/index?matchId=${encodeURIComponent(matchId)}` });
  },

  // ── 商家管理 ──

  onManageVenue() {
    // 商家可在这里扩展：编辑球房信息、下架球房等
    wx.showModal({
      title: "商家管理",
      content: `你正在管理「${this.data.venue.name}」。\n\n作为商家，你可以取消自己球房下的异常球局。`,
      showCancel: false
    });
  },

  async onCancelMatch(e) {
    const match = e.currentTarget.dataset.match;
    if (!match) return;
    if (!this.data.isOwner) {
      wx.showToast({ title: "无权取消该球局", icon: "none" });
      return;
    }

    wx.showModal({
      title: "取消球局",
      content: `确认取消「${match.startAtText}」这场球局吗？\n已冻结的约豆会退还给参与人。`,
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: "处理中..." });
        try {
          await cloudDB.cancelMatchByVenueOwner(match._id);
          wx.hideLoading();
          wx.showToast({ title: "球局已取消", icon: "success" });
          // 刷新球局列表
          const venueId = this.data.venue._id;
          const rawMatches = await cloudDB.getMatchesByVenue(venueId);
          this.setData({
            venueMatches: rawMatches.map((m) => ({
              ...m,
              startAtText: formatDateTime(m.startAt),
              playTypeText: playTypeLabel(m.playType),
              costModeText: costModeLabel(m.costMode || "aa"),
              hostNickname: m.hostNickname || m.host?.nickname || "球友"
            }))
          });
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: err.message || "操作失败", icon: "none" });
        }
      }
    });
  }
});
