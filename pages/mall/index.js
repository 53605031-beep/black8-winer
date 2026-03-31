const cloudDB = require("../../utils/cloudDB");

Page({
  data: {
    goodsList: [],
    accessibleVenues: [],     // 用户参与过的球房列表
    selectedVenueId: null,    // 选中的球房ID
    selectedVenueName: "",     // 选中的球房名称
    currencyType: "score",   // 默认积分专区在前；约豆专区暂未开放
    marqueeText: "在哪个球房获得约豆或积分即可在哪个球房的福利社兑换福利",
    myYuedou: 0,
    myScore: 0,
    loading: true,
    venuePickerVisible: false,
    venuePickerRendered: false,
    venueSearchKeyword: "",
    filteredVenues: []
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
      let venues = [];
      try {
        venues = await cloudDB.getMyAccessibleVenues();
      } catch (_) {
        venues = [];
      }

      let me = null;
      try {
        me = await cloudDB.getCurrentUser();
      } catch (_) {
        me = {};
      }

      const selectedVenueId = this.data.selectedVenueId || null;
      const selectedVenue = venues.find(v => v.venueId === selectedVenueId);
      const currencyType = this.data.currencyType || "score";

      let goods = [];
      // 仅积分专区加载商品；约豆专区暂不开放
      if (currencyType === "score") {
        try {
          [goods] = await Promise.all([
            cloudDB.getGoodsList(selectedVenueId, null, currencyType)
          ]);
        } catch (_) {
          goods = [];
        }
      }

      const keyword = this.data.venueSearchKeyword || "";
      const filteredVenues = venues.filter(v =>
        v.venueName.toLowerCase().includes(keyword.toLowerCase())
      );

      this.setData({
        accessibleVenues: venues,
        selectedVenueId,
        selectedVenueName: selectedVenue?.venueName || "",
        myYuedou: me?.yuedou || 0,
        myScore: me?.score || 0,
        goodsList: goods || [],
        filteredVenues
      });
    } catch (e) {
      console.error("加载福利站失败", e);
    } finally {
      this.setData({ loading: false });
    }
  },

  // 选择球房
  onSelectVenue(e) {
    const venueId = e.currentTarget.dataset.venueid || null;
    const venueName = e.currentTarget.dataset.venuename || "";
    this.setData({ selectedVenueId: venueId, selectedVenueName: venueName }, () => {
      this._loadGoods();
    });
  },

  // 打开球房选择弹层
  openVenuePicker() {
    this.setData({
      venuePickerVisible: true,
      venuePickerRendered: true,
      venueSearchKeyword: "",
      filteredVenues: this.data.accessibleVenues
    });
  },

  // 关闭球房选择弹层
  closeVenuePicker() {
    this.setData({ venuePickerVisible: false });
  },

  // 球房搜索输入
  onVenueSearchInput(e) {
    const keyword = e.detail.value || "";
    const filtered = this.data.accessibleVenues.filter(v =>
      v.venueName.toLowerCase().includes(keyword.toLowerCase())
    );
    this.setData({ venueSearchKeyword: keyword, filteredVenues: filtered });
  },

  // 从弹层选中球房
  onPickVenue(e) {
    const venueId = e.currentTarget.dataset.venueid || null;
    const venueName = e.currentTarget.dataset.venuename || "";
    const selectedVenue = venueId
      ? this.data.accessibleVenues.find(v => v.venueId === venueId)
      : null;
    this.setData({
      selectedVenueId: venueId,
      selectedVenueName: venueName,
      selectedVenue: selectedVenue || null,
      venuePickerVisible: false,
      venueSearchKeyword: ""
    }, () => {
      this._loadGoods();
    });
  },

  // 切换货币类型（约豆专区暂未开放，切到约豆时只更新 Tab，不调接口）
  onSwitchCurrency(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.currencyType) return;
    if (type === "yuedou") {
      this.setData({ currencyType: "yuedou", goodsList: [] });
      return;
    }
    this.setData({ currencyType: "score" }, () => {
      this._loadGoods();
    });
  },

  async _loadGoods() {
    const { selectedVenueId, currencyType } = this.data;
    // 仅积分专区加载商品
    if (currencyType !== "score") {
      this.setData({ goodsList: [] });
      return;
    }
    try {
      const goods = await cloudDB.getGoodsList(selectedVenueId, null, currencyType);
      this.setData({ goodsList: goods });
    } catch (e) {
      console.error("加载商品失败", e);
    }
  },

  goToDetail(e) {
    const goods = e.currentTarget.dataset.goods;
    wx.navigateTo({
      url: `/pages/mall-detail/index?id=${goods._id}&venueId=${this.data.selectedVenueId || ""}`
    });
  },

  goToRecords() {
    wx.navigateTo({ url: "/pages/mall-records/index?type=score" });
  },

  goToExchangeRecords() {
    wx.navigateTo({ url: "/pages/mall-records/index?type=exchange" });
  },

  goToMatches() {
    wx.switchTab({ url: "/pages/matches/index" });
  },

  noop() {}
});
