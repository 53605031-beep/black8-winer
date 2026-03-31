const cloudDB = require("../../utils/cloudDB");

Page({
  data: {
    goods: null,
    currencyType: "score",  // yuedou | score
    myYuedou: 0,
    myScore: 0,
    balance: 0,        // 当前余额
    balanceEnough: false,
    currencyLabel: "积分",
    loading: true,
    showRedeemModal: false,
    redeemForm: {
      name: "",
      phone: "",
      address: ""
    }
  },

  onLoad(options) {
    const { id, currencyType, venueId } = options;
    if (!id) {
      wx.showToast({ title: "商品不存在", icon: "none" });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }
    this._goodsId = id;
    this._selectedVenueId = venueId || null;
    if (currencyType) this._currencyType = currencyType;
    this._load();
  },

  async _load() {
    this.setData({ loading: true });
    try {
      const [goods, me] = await Promise.all([
        cloudDB.getGoodsById(this._goodsId),
        cloudDB.getCurrentUser()
      ]);
      if (!goods) {
        wx.showToast({ title: "商品不存在", icon: "none" });
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }

      // 根据商品的 currencyType 决定用哪个余额
      const currencyType = goods.currencyType || "score";
      const myYuedou = me?.yuedou || 0;
      const myScore = me?.score || 0;
      const balance = currencyType === "yuedou" ? myYuedou : myScore;
      const currencyLabel = currencyType === "yuedou" ? "约豆" : "积分";

      this.setData({
        goods,
        currencyType,
        myYuedou,
        myScore,
        balance,
        balanceEnough: balance >= goods.price,
        currencyLabel,
        loading: false
      });
    } catch (e) {
      console.error("加载商品失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  onRedeem() {
    const { goods, balance, currencyLabel } = this.data;
    if (!goods) return;

    if (balance < goods.price) {
      wx.showModal({
        title: `${currencyLabel}不足`,
        content: `需要 ${goods.price} ${currencyLabel}，你只有 ${balance} ${currencyLabel}`,
        showCancel: false
      });
      return;
    }

    if (goods.stock <= 0) {
      wx.showToast({ title: "库存不足", icon: "none" });
      return;
    }

    // 虚拟商品直接兑换，实物商品需要填写地址
    if (goods.category === "virtual") {
      this._doRedeem(null);
    } else {
      this.setData({ showRedeemModal: true });
    }
  },

  hideRedeemModal() {
    this.setData({ showRedeemModal: false });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`redeemForm.${field}`]: e.detail.value });
  },

  onConfirmRedeem() {
    const { name, phone, address } = this.data.redeemForm;
    if (!name.trim() || !phone.trim() || !address.trim()) {
      wx.showToast({ title: "请填写完整收货信息", icon: "none" });
      return;
    }
    if (!/^1\d{10}$/.test(phone.trim())) {
      wx.showToast({ title: "手机号格式不正确", icon: "none" });
      return;
    }
    this._doRedeem({ name: name.trim(), phone: phone.trim(), address: address.trim() });
  },

  async _doRedeem(address) {
    wx.showLoading({ title: "兑换中..." });
    try {
      const result = await cloudDB.redeemGoods(this._goodsId, address);
      wx.hideLoading();
      const { currencyLabel } = this.data;
      wx.showModal({
        title: "兑换成功！",
        content: address
          ? `已消耗 ${this.data.goods.price} ${currencyLabel}，请等待发货。`
          : `已消耗 ${this.data.goods.price} ${currencyLabel}，兑换码已发放。`,
        showCancel: false,
        success: () => wx.navigateBack()
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || "兑换失败", icon: "none" });
    }
  }
});
