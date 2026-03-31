const cloudDB = require("../../utils/cloudDB");

Page({
  data: {
    venues: [],
    loading: false,
    location: null
  },

  onLoad() {
    this._loadVenues();
  },

  onShow() {
    // 每次显示页面时刷新数据（保持最新状态）
    this._loadVenues();
  },

  async onPullDownRefresh() {
    await this._loadVenues();
    wx.stopPullDownRefresh();
  },

  async _loadVenues() {
    this.setData({ loading: true });

    // 1. 获取定位
    let location = null;
    try {
      location = await this._getLocation();
    } catch (e) {
      console.warn("定位失败，使用无距离模式", e);
    }

    // 2. 从云数据库加载球房（含距离排序）
    try {
      const venues = await cloudDB.getVenues(location);
      // 统一格式化距离文案
      const formattedVenues = venues.map((v) => ({
        ...v,
        distanceText: v.distanceKm != null ? v.distanceKm.toFixed(1) + "km" : "--"
      }));
      this.setData({ venues: formattedVenues, loading: false, location });
    } catch (e) {
      console.error("加载球房失败", e);
      wx.showToast({ title: "加载失败，请下拉刷新", icon: "none" });
      this.setData({ loading: false });
    }
  },

  _getLocation() {
    return new Promise((resolve, reject) => {
      wx.getLocation({
        type: "gcj02",
        success: (res) => resolve({ latitude: res.latitude, longitude: res.longitude }),
        fail: reject
      });
    });
  },

  onOpenVenueDetail(e) {
    const venueId = e.currentTarget.dataset.venueId;
    wx.navigateTo({ url: `/pages/venue-detail/index?venueId=${encodeURIComponent(venueId)}` });
  },

  onCreateFromVenue(e) {
    const venueId = e.currentTarget.dataset.venueId;
    wx.setStorageSync("draft.match.venueId", venueId);
    wx.switchTab({ url: "/pages/publish/index" });
  },

  onNav(e) {
    const venue = this.data.venues.find((v) => v._id === e.currentTarget.dataset.venueId || v.venueId === e.currentTarget.dataset.venueId);
    if (!venue) {
      wx.showToast({ title: "球房不存在", icon: "none" });
      return;
    }

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
  }
});
