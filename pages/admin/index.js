const cloudDB = require("../../utils/cloudDB");

Page({
  data: {
    tab: "pending",
    pendingList: [],
    processedList: [],
    venueList: [],
    loading: false,
    currentApp: null,

    // 添加商户弹窗
    showAddModal: false,
    addForm: {
      name: "",
      address: "",
      phone: "",
      openHours: "10:00-23:00",
      latitude: null,
      longitude: null,
      tags: [],
      selectedPoiName: ""
    },
    tagOptions: ["中式八球", "九球", "斯诺克", "空调", "停车", "包间", "新桌", "wifi"],

    // 删除确认弹窗
    showDeleteModal: false,
    deleteTarget: null
  },

  async onShow() {
    // 从地图选点页返回时，自动填充名称和地址
    if (this.data.showAddModal) {
      const app = getApp();
      if (app.globalData.chosenLocation) {
        const loc = app.globalData.chosenLocation;
        this.setData({
          "addForm.name": loc.name || this.data.addForm.name,
          "addForm.address": loc.address,
          "addForm.latitude": loc.latitude,
          "addForm.longitude": loc.longitude
        });
        app.globalData.chosenLocation = null;
      }
    }
    if (!this._checkAdmin()) return;
    await this._load();
  },

  _checkAdmin() {
    const openid = getApp().globalData.openid || wx.getStorageSync("openid");
    const adminOpenids = getApp().globalData.adminOpenids || [];
    if (adminOpenids.includes(openid)) return true;

    wx.showModal({
      title: "无权限",
      content: "商家后台仅限管理员使用",
      showCancel: false,
      success: () => wx.navigateBack()
    });
    return false;
  },

  async onPullDownRefresh() {
    if (!this._checkAdmin()) {
      wx.stopPullDownRefresh();
      return;
    }
    await this._load();
    wx.stopPullDownRefresh();
  },

  async _load() {
    this.setData({ loading: true });
    try {
      const pending = await cloudDB.getMerchantApplications("pending");
      const processed = await cloudDB.getMerchantApplications(null);
      const processedFiltered = (processed || []).filter((a) => a.status !== "pending");

      // 商户管理 Tab 需要加载所有商户
      let venueList = [];
      if (this.data.tab === "venues") {
        venueList = await cloudDB.getAllVenues();
      }

      this.setData({
        pendingList: pending,
        processedList: processedFiltered.slice(0, 20),
        venueList
      });
    } catch (e) {
      console.error("加载数据失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    if (tab === "venues") {
      this._loadVenues();
    }
  },

  async _loadVenues() {
    try {
      const venueList = await cloudDB.getAllVenues();
      this.setData({ venueList });
    } catch (e) {
      console.error("加载商户列表失败", e);
    }
  },

  onViewDetail(e) {
    const app = e.currentTarget.dataset.app;
    this.setData({ currentApp: app });
    this.showDetailModal(app);
  },

  showDetailModal(app) {
    const tags = (app.venueTags || []).join("、") || "无";
    const content = [
      `申请人：${app.applicantNickname}`,
      `联系电话：${app.venuePhone}`,
      `营业时间：${app.venueOpenHours}`,
      `球房标签：${tags}`,
      `提交时间：${app.createdAt || "—"}`,
      "",
      `球房地址：${app.venueAddress}`
    ].join("\n");

    wx.showModal({
      title: app.venueName,
      content,
      confirmText: app.status === "pending" ? "审批" : "关闭",
      cancelText: "取消",
      success: (res) => {
        if (res.confirm && app.status === "pending") {
          this.doApprove(app);
        }
      }
    });
  },

  async doApprove(app) {
    wx.showModal({
      title: "通过申请",
      content: `确认通过「${app.venueName}」的入驻申请？球房将直接上线。`,
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: "处理中..." });
        try {
          await cloudDB.approveMerchantApplication(app._id);
          wx.hideLoading();
          wx.showToast({ title: "已通过，球房已上线！", icon: "success" });
          this.setData({ currentApp: null });
          await this._load();
        } catch (e) {
          wx.hideLoading();
          console.error("审批失败", e);
          wx.showToast({ title: "操作失败：" + (e.message || "请重试"), icon: "none" });
        }
      }
    });
  },

  async doReject(app) {
    wx.showModal({
      title: "拒绝申请",
      content: `确认拒绝「${app.venueName}」的入驻申请？`,
      editable: true,
      placeholderText: "请输入拒绝原因（选填）",
      success: async (res) => {
        if (!res.confirm) return;
        const reason = res.content?.trim() || "不符合入驻条件";

        wx.showLoading({ title: "处理中..." });
        try {
          await cloudDB.rejectMerchantApplication(app._id, reason);
          wx.hideLoading();
          wx.showToast({ title: "已拒绝", icon: "success" });
          this.setData({ currentApp: null });
          await this._load();
        } catch (e) {
          wx.hideLoading();
          console.error("拒绝失败", e);
          wx.showToast({ title: "操作失败：" + (e.message || "请重试"), icon: "none" });
        }
      }
    });
  },

  onApprove(e) {
    const app = e.currentTarget.dataset.app;
    this.doApprove(app);
  },

  onReject(e) {
    const app = e.currentTarget.dataset.app;
    this.doReject(app);
  },

  onRefresh() {
    this._load();
  },

  // ==================== 商户管理 ====================

  onShowAddModal() {
    const app = getApp();
    app.globalData.chosenLocation = null; // 清理旧选择
    this.setData({
      showAddModal: true,
      addForm: {
        name: "",
        address: "",
        phone: "",
        openHours: "10:00-23:00",
        latitude: null,
        longitude: null,
        tags: [],
        selectedPoiName: ""
      }
    });
  },

  onHideAddModal() {
    this.setData({ showAddModal: false });
  },

  onAddFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`addForm.${field}`]: e.detail.value
    });
  },

  onToggleAddTag(e) {
    const tag = e.currentTarget.dataset.tag;
    const tags = [...this.data.addForm.tags];
    const idx = tags.indexOf(tag);
    if (idx >= 0) {
      tags.splice(idx, 1);
    } else {
      tags.push(tag);
    }
    this.setData({ "addForm.tags": tags });
  },

  onChooseLocation() {
    wx.navigateTo({ url: "/pages/location-picker/index" });
  },

  async onAddVenue() {
    const { name, address, phone, openHours, latitude, longitude, tags } = this.data.addForm;

    if (!name.trim()) {
      wx.showToast({ title: "请填写球房名称", icon: "none" });
      return;
    }

    wx.showLoading({ title: "添加中..." });
    try {
      await cloudDB.addVenue({
        name: name.trim(),
        address: address.trim(),
        phone: phone.trim(),
        openHours: openHours.trim() || "10:00-23:00",
        latitude,
        longitude,
        tags
      });
      wx.hideLoading();
      wx.showToast({ title: "添加成功", icon: "success" });
      this.setData({ showAddModal: false });
      await this._loadVenues();
    } catch (e) {
      wx.hideLoading();
      console.error("添加商户失败", e);
      wx.showToast({ title: "添加失败，请重试", icon: "none" });
    }
  },

  onDeleteVenue(e) {
    const venue = e.currentTarget.dataset.venue;
    this.setData({
      showDeleteModal: true,
      deleteTarget: venue
    });
  },

  onHideDeleteModal() {
    this.setData({ showDeleteModal: false, deleteTarget: null });
  },

  async onConfirmDelete() {
    const { deleteTarget } = this.data;
    if (!deleteTarget) return;

    wx.showLoading({ title: "删除中..." });
    try {
      await cloudDB.deleteVenue(deleteTarget._id);
      wx.hideLoading();
      wx.showToast({ title: "已删除", icon: "success" });
      this.setData({ showDeleteModal: false, deleteTarget: null });
      await this._loadVenues();
    } catch (e) {
      wx.hideLoading();
      console.error("删除商户失败", e);
      wx.showToast({ title: "删除失败，请重试", icon: "none" });
    }
  },

  noop() {}
});
