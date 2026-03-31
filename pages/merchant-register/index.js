const cloudDB = require("../../utils/cloudDB");

Page({
  data: {
    // 三种状态：empty(无申请) | pending(待审核) | approved(已通过) | rejected(被拒绝)
    status: "empty",
    application: null,
    name: "",
    address: "",
    phone: "",
    openHours: "10:00-23:00",
    latitude: null,
    longitude: null,
    selectedPoiName: "",
    tagOptions: ["中式八球", "九球", "斯诺克", "空调", "停车", "包间", "新桌", "wifi"],
    selectedTags: [],
    loading: false,
    rejectReason: ""
  },

  async onLoad() {
    await this._loadMyApplication();
  },

  async _loadMyApplication() {
    try {
      const app = await cloudDB.getMyMerchantApplication();
      if (app) {
        this.setData({ status: app.status, application: app, rejectReason: app.rejectReason || "" });
      } else {
        this.setData({ status: "empty" });
      }
    } catch (e) {
      console.error("加载申请状态失败", e);
      this.setData({ status: "empty" });
    }
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value || "" });
  },

  onAddressInput(e) {
    this.setData({ address: e.detail.value || "" });
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value || "" });
  },

  onHoursInput(e) {
    this.setData({ openHours: e.detail.value || "" });
  },

  onTagToggle(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const selected = [...this.data.selectedTags];
    const pos = selected.indexOf(idx);
    if (pos >= 0) {
      selected.splice(pos, 1);
    } else {
      selected.push(idx);
    }
    this.setData({ selectedTags: selected });
  },

  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          name: res.name,
          address: res.address,
          selectedPoiName: res.name,
          latitude: res.latitude,
          longitude: res.longitude
        });
      },
      fail: (err) => {
        console.error("chooseLocation fail:", err);
        if (err.errMsg && err.errMsg.includes('cancel')) return;
        // 权限被拒绝，引导去设置页开启
        wx.showModal({
          title: '需要位置权限',
          content: '请点击确定跳转到设置页面，开启「位置信息」权限后返回重试。',
          confirmText: '去设置',
          success: (res) => {
            if (res.confirm) {
              wx.openSetting();
            }
          }
        });
      }
    });
  },

  async onSubmit() {
    const { name, address, phone, openHours, selectedTags, tagOptions, latitude, longitude } = this.data;
    if (!name.trim()) {
      wx.showToast({ title: "请填写球房名称", icon: "none" });
      return;
    }
    if (!address.trim()) {
      wx.showToast({ title: "请填写详细地址", icon: "none" });
      return;
    }
    if (!phone.trim()) {
      wx.showToast({ title: "请填写联系电话", icon: "none" });
      return;
    }

    this.setData({ loading: true });
    wx.showLoading({ title: "提交中..." });

    try {
      const tags = selectedTags.map((i) => tagOptions[i]);
      await cloudDB.submitMerchantApplication({
        name: name.trim(),
        address: address.trim(),
        phone: phone.trim(),
        openHours: openHours.trim() || "10:00-23:00",
        tags,
        latitude,
        longitude
      });

      wx.hideLoading();
      wx.showToast({ title: "申请已提交，等待管理员审核！", icon: "success" });

      setTimeout(() => this._loadMyApplication(), 1500);
    } catch (e) {
      wx.hideLoading();
      console.error("提交申请失败", e);
      wx.showToast({ title: "提交失败，请重试", icon: "none" });
      this.setData({ loading: false });
    }
  },

  // 被拒绝后重新申请
  onReapply() {
    this.setData({ status: "empty" });
  },

  // 入驻成功后去附近页面看看
  onGoNearby() {
    wx.switchTab({ url: "/pages/nearby/index" });
  },

  // 入驻成功后进入商家管理
  onEnterMerchant() {
    wx.navigateTo({ url: "/pages/merchant/index" });
  }
});
