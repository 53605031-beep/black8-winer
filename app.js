const cloudDB = require("./utils/cloudDB");

App({
  globalData: {
    city: null,
    location: null,
    userInfo: null,
    openid: null,
    // 管理员 openid 列表，添加你自己的 openid 即可获得商家入驻 / 后台管理权限
    // 获取方式：小程序「我的」页点「复制OpenID」，粘贴到下方数组里（带引号）
    // 改这里后请同步 cloudfunctions/adminMerchant/index.js 里的 ADMIN_OPENIDS，并重新部署该云函数
    adminOpenids: ["oT1J31-mApAYh__uGecWXOU4KvaA"]
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error("微信云开发未初始化，请使用正式版微信开发者工具");
      return;
    }

    wx.cloud.init({
      env: "cloud1-8g68z6qh2f1ad65e",
      traceUser: true
    });

    this.doLogin();
    this._seedIfEmpty();
    this._checkDailyBonus();
  },

  async _seedIfEmpty() {
    try {
      await cloudDB.seedIfEmpty();
    } catch (e) {
      console.warn("种子数据初始化失败（可能已存在）", e);
    }
  },

  /**
   * 检查每日礼包：未领取 OR 约豆已用光，都弹窗提示
   */
  async _checkDailyBonus() {
    const check = async () => {
      try {
        const openid = this.globalData.openid || wx.getStorageSync("openid");
        if (!openid) return;

        const [status, me] = await Promise.all([
          cloudDB.getDailyBonusStatus(),
          cloudDB.getCurrentUser()
        ]);

        const yuedou = me?.yuedou ?? 0;

        // 两种情况弹窗：①今天没领  ②豆已用光
        if (status.claimed && yuedou > 0) return;

        const poolInfo = await cloudDB.getDailyPoolInfo();
        let content = "";
        let confirmText = "立即领取";
        let cancelText = "稍后";

        if (status.claimed && yuedou === 0) {
          // 豆用光了，今天已领过 → 提示明天再来
          content = `💸 你的约豆已用光！\n今日礼包已领取，明早 8:00 资金池刷新再来领哦~`;
          confirmText = "知道了";
          cancelText = "";
        } else if (!status.claimed) {
          // 今天还没领
          content = `今日资金池还有 ${poolInfo.remaining} 约豆等你领取！\n每次领取 +${cloudDB.YUEDOU_DAILY_BONUS} 约豆，先到先得~`;
        }

        // 弹窗询问是否领取（已领过且豆光的情况只有确定按钮）
        wx.showModal({
          title: "🎁 每日礼包",
          content,
          confirmText,
          cancelText,
          success: async (res) => {
            if (!res.confirm) return;
            // 今天还没领才执行领取
            if (!status.claimed) {
              wx.showLoading({ title: "领取中..." });
              try {
                const result = await cloudDB.claimDailyBonus();
                wx.hideLoading();
                if (result.code === "ok") {
                  wx.showModal({
                    title: "领取成功！",
                    content: `+${cloudDB.YUEDOU_DAILY_BONUS} 约豆已到账！\n今日资金池剩余 ${result.remaining} 约豆`,
                    showCancel: false,
                    confirmText: "太棒了"
                  });
                } else if (result.code === "pool_empty") {
                  wx.showModal({
                    title: "来晚了一步",
                    content: "今日资金池已发完，明天早点来哦~",
                    showCancel: false,
                    confirmText: "知道了"
                  });
                }
              } catch (e) {
                wx.hideLoading();
                wx.showToast({ title: "领取失败，请重试", icon: "none" });
              }
            }
          }
        });
      } catch (e) {
        console.warn("每日礼包检查失败", e);
      }
    };

    setTimeout(check, 2000);
  },

  /**
   * 获取 openid（可 await）。「我的」等页面若进来时尚未登录完成，应调用本方法等待。
   * @returns {Promise<string|null>}
   */
  async doLogin() {
    const cachedOpenid = wx.getStorageSync("openid");
    if (cachedOpenid) {
      // 只临时用于页面展示，真正身份必须以 login 云函数返回为准。
      this.globalData.openid = cachedOpenid;
    }

    if (!wx.cloud) {
      this.globalData.lastLoginError = "当前基础库不支持云开发";
      return cachedOpenid || null;
    }

    try {
      wx.showLoading({ title: "登录中...", mask: true });

      const { result } = await wx.cloud.callFunction({
        name: "login"
      });

      if (result && result.openid) {
        this.globalData.openid = result.openid;
        wx.setStorageSync("openid", result.openid);
        this.globalData.lastLoginError = "";
        console.log("登录成功，openid:", result.openid);
        return result.openid;
      }

      this.globalData.lastLoginError = "云函数 login 未返回 openid，请检查云函数是否已部署";
      return null;
    } catch (e) {
      const msg = (e && (e.errMsg || e.message)) ? String(e.errMsg || e.message) : String(e);
      this.globalData.lastLoginError = msg;
      console.error("登录失败", e);
      return cachedOpenid || null;
    } finally {
      wx.hideLoading();
    }
  },

  setUserInfo(userInfo) {
    this.globalData.userInfo = userInfo;
    wx.setStorageSync("userInfo", userInfo);
  }
});
