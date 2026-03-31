// 地点选择页：直接调起微信原生地图选择器，无需域名白名单
Page({
  data: {
    loading: false
  },

  onLoad() {
    // 进入页面直接调起微信地图选择器
    this._openMapPicker();
  },

  _openMapPicker() {
    this.setData({ loading: true });
    wx.chooseLocation({
      success: (res) => {
        if (!res.name && !res.address) {
          // 空结果，用户可能取消了
          this.setData({ loading: false });
          return;
        }

        // 把选中的地点数据传回上一页的 addForm
        const pages = getCurrentPages();
        const prevPage = pages[pages.length - 2];
        if (prevPage) {
          prevPage.setData({
            "addForm.name": res.name,
            "addForm.address": res.address,
            "addForm.latitude": res.latitude,
            "addForm.longitude": res.longitude
          });
        }
        wx.navigateBack();
      },
      fail: (err) => {
        this.setData({ loading: false });
        const msg = err.errMsg || "";
        if (msg.includes("cancel")) {
          // 用户取消，返回上一页
          wx.navigateBack();
          return;
        }
        console.error("chooseLocation fail:", err);
        wx.showModal({
          title: "需要位置权限",
          content: "请点击确定跳转设置页，开启「位置信息」权限后返回重试。",
          confirmText: "去设置",
          success: (res) => {
            if (res.confirm) {
              wx.openSetting();
            } else {
              wx.navigateBack();
            }
          }
        });
      }
    });
  }
});
