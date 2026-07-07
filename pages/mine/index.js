const cloudDB = require("../../utils/cloudDB");
const { formatDateTime, playTypeLabel, costModeLabel } = require("../../utils/format");

/**
 * 判断当前用户是否有权关闭这条球局
 * - 招募中：开赛时间已过，只有发起人能关闭
 * - 进行中：持续超过 6 小时，发起人或参与者都能关闭
 */
function computeCanClose(match, myOpenid) {
  if (!["recruiting", "playing"].includes(match.status)) return false;

  const isHost = match.hostOpenid === myOpenid;
  const isParticipant = (match.participants || []).some((p) => p.openid === myOpenid);
  if (!isHost && !isParticipant) return false;

  if (match.status === "recruiting") {
    // 招募中：只有发起人能关，且必须在开赛时间已过后
    if (!isHost) return false;
    if (!match.startAt) return false;
    return new Date(match.startAt) < new Date();
  }

  if (match.status === "playing") {
    // 进行中：超过 6 小时就能关
    if (!match.startedAt) return false;
    const hoursSinceStart = (Date.now() - new Date(match.startedAt).getTime()) / 3600000;
    return Number.isFinite(hoursSinceStart) && hoursSinceStart > 6;
  }

  return false;
}

Page({
  data: {
    me: null,
    myHostedMatches: [],
    myJoinedMatches: [],
    tab: "hosted",
    openid: "",
    loginErrorMsg: "",
    profileLoading: true,
    dailyClaimed: false,
    dailyPoolRemaining: 0,
    signedInToday: false,
    activityStatus: null
  },

  async onShow() {
    const app = getApp();
    // 与 app.onLaunch 里的 doLogin 竞态：这里主动等待拿到 openid
    let oid =
      cloudDB.getOpenid() ||
      wx.getStorageSync("openid") ||
      (await app.doLogin()) ||
      wx.getStorageSync("openid") ||
      "";
    if (oid) {
      app.globalData.openid = oid;
    }

    const errMsg = oid
      ? ""
      : (app.globalData.lastLoginError ||
        "未获取到 OpenID。请在开发者工具中：右键 cloudfunctions/login → 上传并部署，并确认 app.js 里云环境 ID 正确。");

    this.setData({
      openid: oid,
      loginErrorMsg: errMsg,
      profileLoading: !!oid
    });

    if (!oid) {
      this.setData({
        me: null,
        myHostedMatches: [],
        myJoinedMatches: [],
        profileLoading: false
      });
      return;
    }

    try {
      // 所有独立的数据库查询并行发出，减少等待时间
      // 只查活跃球局（recruiting + playing），已结束/已取消的不展示在"我的"
      const [me, lb, dailyStatus, poolInfo, activityStatus, activeMatches] = await Promise.all([
        cloudDB.getCurrentUser(),
        cloudDB.getLeaderboard(),
        cloudDB.getDailyBonusStatus(),
        cloudDB.getDailyPoolInfo(),
        cloudDB.getActivityStatus(),
        cloudDB.getMatches({ status: cloudDB.DB().command.in(["recruiting", "playing"]) })
      ]);

      if (!me) {
        this.setData({
          loginErrorMsg: "已登录但用户资料加载失败，请检查云数据库 yueqiu8_users 集合权限与网络。",
          profileLoading: false
        });
        return;
      }

      const rank = cloudDB.calcRankByScore(me.score || 0);
      const myRank = lb.findIndex((x) => x._id === me._id) + 1;

      // 在本地分拣我发起的和我加入的球局（避免查两次全量）
      const hostedMatches = activeMatches.filter((m) => m.hostOpenid === me.openid);
      const joinedMatches = activeMatches.filter(
        (m) =>
          m.hostOpenid !== me.openid &&
          (m.participants || []).some((p) => p.openid === me.openid)
      );

      this.setData({
        me: { ...me, rankName: rank.name, rankColor: rank.color, rank: myRank },
        myHostedMatches: hostedMatches.map((m) => ({
          ...m,
          startAtText: formatDateTime(m.startAt),
          playTypeText: playTypeLabel(m.playType),
          costModeText: costModeLabel(m.costMode),
          _canClose: computeCanClose(m, me.openid)
        })),
        myJoinedMatches: joinedMatches.map((m) => ({
          ...m,
          startAtText: formatDateTime(m.startAt),
          playTypeText: playTypeLabel(m.playType),
          costModeText: costModeLabel(m.costMode),
          _canClose: computeCanClose(m, me.openid)
        })),
        openid: me.openid || cloudDB.getOpenid() || "",
        loginErrorMsg: "",
        profileLoading: false,
        dailyClaimed: dailyStatus.claimed,
        dailyPoolRemaining: poolInfo.remaining,
        signedInToday: activityStatus ? activityStatus.signedInToday : false,
        activityStatus
      });
    } catch (e) {
      console.error("加载用户数据失败", e);
      this.setData({
        loginErrorMsg: "加载个人资料失败：" + ((e && e.errMsg) || e.message || "请检查网络与数据库权限"),
        profileLoading: false
      });
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  /** 登录失败时重试 */
  async onRetryLogin() {
    wx.removeStorageSync("openid");
    getApp().globalData.openid = null;
    this.setData({ loginErrorMsg: "", profileLoading: true, openid: "" });
    await this.onShow();
  },

  /** 复制 OpenID，方便粘贴到 app.js 的 adminOpenids */
  onCopyOpenid() {
    const oid = this.data.openid || cloudDB.getOpenid();
    if (!oid) {
      wx.showToast({ title: "请先等登录完成", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: oid,
      success: () => {
        wx.showModal({
          title: "已复制 OpenID",
          content: "请打开项目里的 app.js，把 adminOpenids 改成：\n\nadminOpenids: [\"" + oid + "\"]\n\n保存后重新编译即可。",
          showCancel: false
        });
      }
    });
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
  },

  /**
   * 头像选择回调（微信原生 chooseAvatar）
   */
  onChooseAvatar(e) {
    console.log("头像选择回调，原始数据：", JSON.stringify(e.detail));
    const avatarUrl = e.detail.avatarUrl;
    if (!avatarUrl) {
      console.log("头像URL为空");
      return;
    }
    this._saveProfile({ avatarUrl });
  },

  /**
   * 昵称选择回调（微信原生 chooseNickname）
   */
  onChooseNickname(e) {
    console.log("onChooseNickname 被触发，原始数据：", JSON.stringify(e.detail));
    const nickname = (e.detail && e.detail.nickname || "").trim();
    console.log("获取到的昵称：", nickname);
    if (!nickname) {
      wx.showToast({ title: "昵称不能为空", icon: "none" });
      return;
    }
    if (nickname === "球友") {
      console.log("昵称仍是默认的'球友'，不保存");
      return;
    }
    this._saveProfile({ nickname });
  },

  /**
   * 统一保存用户资料到云数据库
   */
  async _saveProfile(profile) {
    console.log("开始保存资料：", JSON.stringify(profile));
    wx.showLoading({ title: "保存中..." });
    try {
      const result = await cloudDB.updateUserProfile(profile);
      console.log("云数据库更新结果：", result);
      const me = await cloudDB.getCurrentUser();
      console.log("重新获取用户数据：", JSON.stringify(me));
      const rank = cloudDB.calcRankByScore(me.score || 0);
      this.setData({
        me: { ...me, rankName: rank.name, rankColor: rank.color }
      });
      wx.hideLoading();
      wx.showToast({ title: "已保存！", icon: "success" });
    } catch (e) {
      wx.hideLoading();
      console.error("保存资料失败，错误详情：", e);
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }
  },

  onOpenMyMatch(e) {
    const matchId = e.currentTarget.dataset.matchId;
    wx.navigateTo({ url: `/pages/match-detail/index?matchId=${encodeURIComponent(matchId)}` });
  },

  async onCloseMatch(e) {
    const match = e.currentTarget.dataset.match;
    if (!match) return;

    const me = this.data.me;
    if (!me) return;

    const isHost = match.hostOpenid === me.openid;
    const isParticipant = (match.participants || []).some((p) => p.openid === me.openid);

    // 招募中：只有发起人能关闭
    if (match.status === "recruiting") {
      if (!isHost) {
        wx.showToast({ title: "仅发起人可关闭", icon: "none" });
        return;
      }
    }

    const confirmMsg = match.status === "recruiting"
      ? `确认关闭「${match.venueName}」这场招募中的球局吗？`
      : `确认关闭「${match.venueName}」这场进行中的球局吗？\n\n双方冻结的约豆将全部解冻。`;

    wx.showModal({
      title: "关闭球局",
      content: confirmMsg,
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: "处理中..." });
        try {
          await cloudDB.closeMatch(match._id, me.openid);
          wx.hideLoading();
          wx.showToast({ title: "球局已关闭", icon: "success" });
          this.onShow(); // 刷新列表
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: (err.message || "操作失败"), icon: "none" });
        }
      }
    });
  },

  onGoMatches() {
    wx.switchTab({ url: "/pages/matches/index" });
  },

  onLeaderboard() {
    wx.navigateTo({ url: "/pages/leaderboard/index" });
  },

  onLocationSetting() {
    wx.openSetting();
  },

  async onNotifications() {
    try {
      const openid = cloudDB.getOpenid();
      const notices = await cloudDB.getNotices(openid);
      if (!notices || notices.length === 0) {
        wx.showToast({ title: "暂无通知", icon: "none" });
        return;
      }

      const noticeList = notices.map((n) => {
        let content = "";
        if (n.type === "match_result") {
          content = `比赛结果：${n.winnerNickname || "某用户"} 获得 +${n.winnerGain} 分，` +
                    `${n.loserNickname || "某用户"} 失去 ${n.loserLose} 分`;
        } else if (n.type === "match_joined") {
          content = `${n.nickname || "某用户"} 加入了你的球局`;
        } else if (n.type === "match_full") {
          content = `你的球局已满员`;
        } else if (n.type === "merchant_approved") {
          content = n.content || "你的商家入驻申请已通过！";
        } else if (n.type === "merchant_rejected") {
          content = n.content || "你的商家入驻申请被拒绝。";
        } else if (n.type === "daily_bonus") {
          content = n.content || "每日礼包到账通知";
        } else {
          content = n.content || "有新通知";
        }
        return content;
      }).join("\n\n");

      wx.showModal({
        title: "通知中心",
        content: noticeList,
        showCancel: false
      });
    } catch (e) {
      console.error("加载通知失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  /**
   * 点击「商家入驻」按钮：智能判断身份后导航
   * - 已是商家（role === 'merchant'）→ 进商家管理后台
   * - 否则 → 进入驻申请页（页面内自动展示当前状态：空/待审核/已通过/被拒绝）
   */
  onContactAdmin() {
    const me = this.data.me;
    if (me && me.role === "merchant") {
      wx.navigateTo({ url: "/pages/merchant/index" });
    } else {
      wx.navigateTo({ url: "/pages/merchant-register/index" });
    }
  },

  onMerchant() {
    wx.navigateTo({ url: "/pages/merchant/index" });
  },

  onAdmin() {
    const openid = getApp().globalData.openid || wx.getStorageSync("openid");
    const adminOpenids = getApp().globalData.adminOpenids || [];
    if (!adminOpenids.includes(openid)) {
      wx.showModal({
        title: "无权限",
        content: "后台管理仅限管理员使用。",
        showCancel: false
      });
      return;
    }
    wx.navigateTo({ url: "/pages/admin/index" });
  },

  onAbout() {
    wx.showModal({
      title: "约球8",
      content: "约球8 · 台球爱好者社区\n积分对战，等级晋升，附近约局。",
      showCancel: false
    });
  },

  onAgreement() {
    wx.navigateTo({ url: "/pages/agreement/index" });
  },

  /** 点击每日礼包领取 */
  async onClaimDailyBonus() {
    try {
      const result = await cloudDB.claimDailyBonus();
      if (result.code === "ok") {
        wx.showModal({
          title: "领取成功！",
          content: `+${cloudDB.YUEDOU_DAILY_BONUS} 约豆已到账！\n今日资金池剩余 ${result.remaining} 约豆`,
          showCancel: false,
          confirmText: "太棒了"
        });
        const poolInfo = await cloudDB.getDailyPoolInfo();
        const me = await cloudDB.getCurrentUser();
        this.setData({
          dailyClaimed: true,
          dailyPoolRemaining: result.remaining,
          me: { ...this.data.me, yuedou: me.yuedou }
        });
      } else if (result.code === "already_claimed") {
        this.setData({ dailyClaimed: true });
        wx.showModal({
          title: "今日已领取",
          content: "明早8点资金池刷新后再来哦~",
          showCancel: false,
          confirmText: "知道了"
        });
      } else if (result.code === "pool_empty") {
        this.setData({ dailyClaimed: true, dailyPoolRemaining: 0 });
        wx.showModal({
          title: "来晚了一步",
          content: "今日资金池已发完，明天早点来哦~",
          showCancel: false,
          confirmText: "知道了"
        });
      }
    } catch (e) {
      console.error("领取每日礼包失败", e);
      wx.showToast({ title: "领取失败，请重试", icon: "none" });
    }
  },

  /** 每日签到 */
  async onDailySignIn() {
    try {
      const result = await cloudDB.dailySignIn();
      if (result.code === "already_signed_in") {
        wx.showToast({ title: "今日已签到", icon: "none" });
        return;
      }
      const totalGain = result.signInScore + result.consecutiveBonus;
      let msg = `+${result.signInScore} 积分`;
      if (result.consecutiveBonus > 0) {
        msg += ` + 连续签到奖励 +${result.consecutiveBonus}`;
      }
      msg += `\n连续签到 ${result.consecutiveDays} 天`;
      if (result.nextMilestone) {
        msg += `\n再签 ${result.nextMilestone.days - result.consecutiveDays} 天可领 +${result.nextMilestone.bonus} 额外奖励`;
      }
      wx.showModal({
        title: "签到成功！",
        content: msg,
        showCancel: false,
        confirmText: "继续加油"
      });
      // 刷新数据
      await this._refreshActivity();
    } catch (e) {
      console.error("签到失败", e);
      wx.showToast({ title: "签到失败，请重试", icon: "none" });
    }
  },

  /** 领取周活跃奖励 */
  async onClaimWeekly() {
    try {
      const result = await cloudDB.claimWeeklyReward();
      if (result.code === "ok") {
        wx.showModal({
          title: "领取成功！",
          content: `本周参与 ${result.weeklyMatches} 场，获得 +${result.reward} 积分奖励！`,
          showCancel: false,
          confirmText: "太棒了"
        });
        await this._refreshActivity();
      } else if (result.code === "not_enough") {
        wx.showModal({
          title: "还差一点点",
          content: `本周已参与 ${result.weeklyMatches} 场，还差 ${result.target - result.weeklyMatches} 场可领取 +${cloudDB.SCORE_WEEKLY_REWARD} 积分`,
          showCancel: false,
          confirmText: "去找局"
        });
      } else if (result.code === "already_claimed_or_reset") {
        wx.showToast({ title: "本周已领取", icon: "none" });
      }
    } catch (e) {
      console.error("领取周奖励失败", e);
      wx.showToast({ title: "领取失败，请重试", icon: "none" });
    }
  },

  /** 领取月活跃奖励 */
  async onClaimMonthly() {
    try {
      const result = await cloudDB.claimMonthlyReward();
      if (result.code === "ok") {
        wx.showModal({
          title: "领取成功！",
          content: `本月参与 ${result.monthlyMatches} 场，获得 +${result.reward} 积分奖励！`,
          showCancel: false,
          confirmText: "太棒了"
        });
        await this._refreshActivity();
      } else if (result.code === "not_enough") {
        wx.showModal({
          title: "还差一点点",
          content: `本月已参与 ${result.monthlyMatches} 场，还差 ${result.target - result.monthlyMatches} 场可领取 +${cloudDB.SCORE_MONTHLY_REWARD} 积分`,
          showCancel: false,
          confirmText: "继续加油"
        });
      } else if (result.code === "already_claimed_or_reset") {
        wx.showToast({ title: "本月已领取", icon: "none" });
      }
    } catch (e) {
      console.error("领取月奖励失败", e);
      wx.showToast({ title: "领取失败，请重试", icon: "none" });
    }
  },

  /** 刷新活跃数据（签到/领奖后调用） */
  async _refreshActivity() {
    try {
      const activityStatus = await cloudDB.getActivityStatus();
      const me = await cloudDB.getCurrentUser();
      const rank = cloudDB.calcRankByScore(me.score || 0);
      this.setData({
        signedInToday: activityStatus ? activityStatus.signedInToday : false,
        activityStatus,
        me: { ...this.data.me, score: me.score, rankName: rank.name, rankColor: rank.color }
      });
    } catch (e) {
      console.error("刷新活跃数据失败", e);
    }
  }
});
