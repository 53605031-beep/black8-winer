const cloudDB = require("../../utils/cloudDB");

Page({
  data: {
    tab: "goods",
    goodsList: [],
    redemptionList: [],
    loading: false,
    showAddModal: false,
    editGoods: null,
    form: {
      name: "",
      description: "",
      image: "",
      price: "",
      stock: "",
      category: "physical",
      currencyType: "score",  // yuedou=约豆商城, score=积分商城
      sort: "0",
      status: "active"
    }
  },

  onShow() {
    this._checkAdmin();
  },

  async _checkAdmin() {
    const openid = getApp().globalData.openid || wx.getStorageSync("openid");
    const adminOpenids = getApp().globalData.adminOpenids || [];
    if (!adminOpenids.includes(openid)) {
      wx.showModal({
        title: "无权限",
        content: "商品管理仅限管理员使用",
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }
    await this._load();
  },

  async _load() {
    this.setData({ loading: true });
    try {
      if (this.data.tab === "goods") {
        const goods = await cloudDB.getAllGoods();
        this.setData({ goodsList: goods });
      } else {
        const list = await cloudDB.getRedemptionsForFulfillment();
        const redemptionList = list.map((item) => ({
          ...item,
          createdAtText: this.formatDate(item.createdAt),
          addressLine: item.address
            ? `${item.address.name || ""} ${item.address.phone || ""} ${item.address.address || ""}`.trim()
            : ""
        }));
        this.setData({ redemptionList });
      }
    } catch (e) {
      console.error("加载失败", e);
    } finally {
      this.setData({ loading: false });
    }
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab }, () => this._load());
  },

  // ── 添加/编辑商品 ──
  onShowAddModal(e) {
    const goods = e?.currentTarget?.dataset?.goods || null;
    if (goods) {
      this.setData({
        editGoods: goods,
        showAddModal: true,
        form: {
          name: goods.name || "",
          description: goods.description || "",
          image: goods.image || "",
          price: String(goods.price || ""),
          stock: String(goods.stock || ""),
          category: goods.category || "physical",
          currencyType: goods.currencyType || "score",
          sort: String(goods.sort || "0"),
          status: goods.status || "active"
        }
      });
    } else {
      this.setData({
        editGoods: null,
        showAddModal: true,
        form: { name: "", description: "", image: "", price: "", stock: "", category: "physical", currencyType: "score", sort: "0", status: "active" }
      });
    }
  },

  onHideAddModal() {
    this.setData({ showAddModal: false, editGoods: null });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onPickCategory(e) {
    const cat = e.currentTarget.dataset.cat;
    if (cat) this.setData({ "form.category": cat });
  },

  onPickCurrencyType(e) {
    const ct = e.currentTarget.dataset.ct;
    if (ct) this.setData({ "form.currencyType": ct });
  },

  onPickStatus(e) {
    const st = e.currentTarget.dataset.st;
    if (st) this.setData({ "form.status": st });
  },

  async onSaveGoods() {
    const { form, editGoods } = this.data;
    if (!form.name.trim()) {
      wx.showToast({ title: "请填写商品名称", icon: "none" });
      return;
    }
    if (!form.price || parseInt(form.price) <= 0) {
      wx.showToast({ title: "请填写正确的价格", icon: "none" });
      return;
    }

    wx.showLoading({ title: "保存中..." });
    try {
      await cloudDB.saveGoods(form, editGoods?._id || null);
      wx.hideLoading();
      wx.showToast({ title: "保存成功", icon: "success" });
      this.onHideAddModal();
      await this._load();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },

  async onToggleStatus(e) {
    const goods = e.currentTarget.dataset.goods;
    const newStatus = goods.status === "active" ? "inactive" : "active";
    wx.showModal({
      title: newStatus === "active" ? "上架商品" : "下架商品",
      content: `确认${newStatus === "active" ? "上架" : "下架"}「${goods.name}」？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "处理中..." });
        try {
          await cloudDB.saveGoods({ ...goods, status: newStatus }, goods._id);
          wx.hideLoading();
          wx.showToast({ title: "操作成功", icon: "success" });
          await this._load();
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: "操作失败", icon: "none" });
        }
      }
    });
  },

  async onDeleteGoods(e) {
    const goods = e.currentTarget.dataset.goods;
    wx.showModal({
      title: "删除商品",
      content: `确认删除「${goods.name}」？此操作不可恢复。`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "删除中..." });
        try {
          await cloudDB.deleteGoods(goods._id);
          wx.hideLoading();
          wx.showToast({ title: "已删除", icon: "success" });
          await this._load();
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      }
    });
  },

  // ── 发货管理 ──
  async onShip(e) {
    const item = e.currentTarget.dataset.item;
    wx.showModal({
      title: "确认发货",
      content: `确认「${item.goodsName}」已发货给「${item.nickname}」？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "处理中..." });
        try {
          await cloudDB.updateRedemptionStatus(item._id, "shipped");
          wx.hideLoading();
          wx.showToast({ title: "已标记发货", icon: "success" });
          await this._load();
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: "操作失败", icon: "none" });
        }
      }
    });
  },

  async onComplete(e) {
    const item = e.currentTarget.dataset.item;
    wx.showModal({
      title: "确认完成",
      content: `确认「${item.goodsName}」已完成兑换？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "处理中..." });
        try {
          await cloudDB.updateRedemptionStatus(item._id, "completed");
          wx.hideLoading();
          wx.showToast({ title: "已完成", icon: "success" });
          await this._load();
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: "操作失败", icon: "none" });
        }
      }
    });
  },

  formatDate(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },

  noop() {}
});
