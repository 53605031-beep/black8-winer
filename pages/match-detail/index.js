const cloudDB = require("../../utils/cloudDB");
const { formatDateTime, playTypeLabel, costModeLabel, skillLabel } = require("../../utils/format");

// 约豆常量（直接写入避免每次读取 cloudDB）
const YUEDOU_FROZEN = 500;
const YUEDOU_WINNER = 420;
const YUEDOU_LOSER  = 500;
const YUEDOU_SYSTEM = 80;

Page({
  data: {
    YUEDOU_FROZEN,
    YUEDOU_WINNER,
    YUEDOU_LOSER,
    YUEDOU_SYSTEM,
    matchId: null,
    match: null,
    isHost: false,
    hasJoined: false,
    myOpenid: "",
    myChoice: null,       // "win" | "lose" | null（我已选的结果）
    opponentChoice: null, // 对手的已选结果（null=未选）
    opponentReady: false,
    bothReady: false,
    resultLabel: "",      // 最终结算描述
    loading: false,

    // 位置校验相关
    locationVerified: false,
    otherVerified: false,
    canVerify: false,

    // 授权提示
    showAuthHint: false
  },

  async onLoad(query) {
    const matchId = query.matchId || null;
    if (!matchId) {
      wx.showToast({ title: "参数错误", icon: "none" });
      return;
    }

    const openid = cloudDB.getOpenid() || "";
    this.setData({ matchId, myOpenid: openid });
    await this._loadMatch(matchId);
  },

  async onShow() {
    const { matchId } = this.data;
    if (matchId) await this._loadMatch(matchId);
  },

  async _loadMatch(matchId) {
    try {
      const m = await cloudDB.getMatchById(matchId);
      if (!m) {
        wx.showToast({ title: "球局不存在", icon: "none" });
        return;
      }

      const openid = cloudDB.getOpenid() || "";
      
      // 调试日志
      if (!openid) {
        console.warn("[DEBUG] openid 为空，可能未登录");
      }
      
      const isHost = m.hostOpenid === openid;
      const hasJoined = (m.participants || []).some((p) => p.openid === openid);

      // 我的选择
      const me = (m.participants || []).find((p) => p.openid === openid);
      const myChoice = me?.resultChoice || null;

      // 对手的选择（仅两人时）
      const opponent = (m.participants || []).find((p) => p.openid !== openid);
      const opponentChoice = opponent?.resultChoice || null;

      // 双方都选了
      const bothReady = myChoice != null && opponentChoice != null;

      // 结算描述
      let resultLabel = "";
      if (m.status === "settled" && m.finalParticipants) {
        const fp = m.finalParticipants;
        if (fp.length === 2) {
          const hostCh = fp[0].resultChoice;
          const joinCh = fp[1].resultChoice;
          if (hostCh === "win" && joinCh === "lose") {
            const winner = fp[0].nickname;
            const loser  = fp[1].nickname;
            resultLabel = `${winner} 赢，获得 ${YUEDOU_WINNER} 约豆；${loser} 输，扣 ${YUEDOU_LOSER} 约豆`;
          } else if (hostCh === "lose" && joinCh === "win") {
            const winner = fp[1].nickname;
            const loser  = fp[0].nickname;
            resultLabel = `${winner} 赢，获得 ${YUEDOU_WINNER} 约豆；${loser} 输，扣 ${YUEDOU_LOSER} 约豆`;
          } else {
            resultLabel = "结果不一致，请重新协商";
          }
        }
      }

      // 约豆规则说明
      const yuedouRule = `每人冻结 ${YUEDOU_FROZEN} 约豆\n赢方得 ${YUEDOU_WINNER}，组局成功消耗 ${YUEDOU_SYSTEM}\n负方扣 ${YUEDOU_LOSER}`;

      // 位置校验状态
      const myVerified = me?.locationVerified || false;
      const other = (m.participants || []).find((p) => p.openid !== openid);
      const otherVerified = other?.locationVerified || false;
      const canVerify = m.status === "recruiting" && hasJoined;

      this.setData({
        match: {
          ...m,
          startAtText: formatDateTime(m.startAt),
          playTypeText: playTypeLabel(m.playType),
          costModeText: costModeLabel(m.costMode || "aa"),
          skillText: skillLabel(m.skillRequirement || "any"),
          hostNickname: m.hostNickname || m.host?.nickname || "球友",
          yuedouRule
        },
        isHost,
        hasJoined,
        myChoice,
        opponentChoice,
        opponentReady: opponentChoice != null,
        bothReady,
        resultLabel,
        locationVerified: myVerified,
        otherVerified,
        canVerify
      });
    } catch (e) {
      console.error("加载球局失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  // ── 加入约局 ──────────────────────────────────────────────
  async onJoin() {
    const { matchId } = this.data;
    if (!matchId) return;

    // 时间冲突检测（与发起时保持一致）
    const activeMatches = await cloudDB.getMyActiveMatches();
    if (activeMatches.length > 0) {
      const m = activeMatches[0];
      const statusText = m.status === "recruiting" ? "招募中" : "进行中";
      wx.showModal({
        title: "已有进行中的球局",
        content: `你当前在「${m.venueName}」有一个${statusText}的球局，请先结束后再加入新的，避免时间冲突哦~`,
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }

    // 约豆不足时提示
    const me = await cloudDB.getCurrentUser();
    const yuedou = me?.yuedou ?? 0;
    if (yuedou < YUEDOU_FROZEN) {
      wx.showModal({
        title: "约豆不足",
        content: `加入约局需冻结 ${YUEDOU_FROZEN} 约豆，你当前只有 ${yuedou} 约豆。\n请先获取更多约豆后再加入。`,
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }

    // 检测昵称是否为默认"球友"，是则要求先授权获取微信头像昵称
    if (me?.nickname === "球友") {
      wx.showModal({
        title: "设置头像和昵称",
        content: "加入约局前需要设置你的微信头像和昵称，请点击下方「微信授权获取头像昵称」按钮完成设置",
        confirmText: "去授权",
        cancelText: "稍后",
        success: async (res) => {
          if (!res.confirm) return;
          // 将 join 按钮替换为授权按钮提示，让用户点击页面上的授权按钮
          this.setData({ showAuthHint: true });
          wx.showToast({ title: "请点击下方「微信授权获取头像昵称」按钮", icon: "none", duration: 3000 });
        }
      });
      return;
    }

    // 昵称已设置，直接加入
    await this._doJoin();
  },

  /**
   * 微信一键获取头像和昵称
   * 使用 button open-type="chooseAvatar" + bindchooseavatar 获取微信头像
   */
  onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl;

    // 弹出昵称输入框
    wx.showModal({
      title: "设置昵称",
      editable: true,
      placeholderText: "请输入你的昵称",
      success: async (res) => {
        if (!res.confirm || !res.content || !res.content.trim()) {
          wx.showToast({ title: "昵称不能为空", icon: "none" });
          return;
        }
        const nickname = res.content.trim();

        wx.showLoading({ title: "保存中..." });
        try {
          await cloudDB.updateUserProfile({ nickname, avatarUrl });
          wx.hideLoading();
          wx.showToast({ title: "资料设置成功！", icon: "success" });
          await this._loadMatch(this.data.matchId);
          // 资料设置成功后，自动加入
          await this._doJoin();
        } catch (err) {
          wx.hideLoading();
          console.error("[ERROR] 保存资料失败:", err);
          wx.showToast({ title: "保存失败：" + (err.message || "请重试"), icon: "none" });
        }
      }
    });
  },

  async _doJoin() {
    const { matchId } = this.data;
    this.setData({ loading: true });
    try {
      wx.showLoading({ title: "加入中..." });
      
      // 调试：打印 matchId
      console.log("[DEBUG] _doJoin called, matchId:", matchId);
      
      const res = await cloudDB.joinMatch(matchId);
      wx.hideLoading();
      
      console.log("[DEBUG] joinMatch result:", res);
      
      if (res.code === "already_joined") {
        wx.showToast({ title: "已加入过该球局", icon: "none" });
        return;
      }
      
      wx.showToast({ title: "加入成功！冻结500约豆", icon: "success" });
      await this._loadMatch(matchId);
    } catch (e) {
      wx.hideLoading();
      console.error("[ERROR] 加入失败:", e);
      wx.showToast({ title: "加入失败：" + (e.message || "请重试"), icon: "none" });
      // 加入失败时重新加载一次，确保 UI 同步
      try { await this._loadMatch(matchId); } catch (_) {}
    } finally {
      this.setData({ loading: false });
    }
  },

  // ── 退出约局 ──────────────────────────────────────────────
  async onLeave() {
    const { matchId, match } = this.data;
    if (!matchId) return;

    let content = "确定退出此球局吗？";
    if (match?.status === "recruiting") {
      content = "确定退出此球局吗？\n（冻结的约豆将全额退还）";
    }

    wx.showModal({
      title: "退出确认",
      content,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "退出中..." });
        try {
          const result = await cloudDB.leaveMatch(matchId);
          wx.hideLoading();
          if (result.code === "canceled_by_host") {
            wx.showToast({ title: "你是发起人，球局已撤销", icon: "none" });
          } else {
            wx.showToast({ title: "已退出，冻结约豆已退还", icon: "success" });
          }
          setTimeout(() => wx.navigateBack(), 1000);
        } catch (e) {
          wx.hideLoading();
          console.error("退出失败", e);
          wx.showToast({ title: "退出失败：" + (e.message || "请重试"), icon: "none" });
        }
      }
    });
  },

  // ── 发起人：确认比赛开始（recruiting → playing） ─────────
  async onConfirmStart() {
    const { matchId } = this.data;
    if (!matchId) return;

    wx.showModal({
      title: "确认开始比赛",
      content: "确认两人已到店并开始比赛？\n比赛开始后将进入结果选择阶段。",
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "确认中..." });
        try {
          await cloudDB.confirmMatch(matchId);
          wx.hideLoading();
          wx.showToast({ title: "比赛已开始！", icon: "success" });
          await this._loadMatch(matchId);
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: e.message || "操作失败", icon: "none" });
        }
      }
    });
  },

  // ── 位置校验 ────────────────────────────────────────────
  async onVerifyLocation() {
    const { matchId } = this.data;
    if (!matchId) return;

    wx.showLoading({ title: "校验中..." });
    try {
      const pos = await new Promise((resolve, reject) => {
        wx.getLocation({
          type: "gcj02",
          success: (res) => resolve(res),
          fail: () => reject(new Error("获取位置失败"))
        });
      });

      const result = await cloudDB.verifyLocation(
        matchId,
        pos.latitude,
        pos.longitude,
        0.5  // 500米内
      );

      wx.hideLoading();
      if (result.code === "too_far") {
        wx.showModal({
          title: "位置不在球房附近",
          content: `你距离球房约 ${result.distance.toFixed(1)}km，请到店后再校验`,
          showCancel: false
        });
        return;
      }

      wx.showToast({ title: "校验成功！", icon: "success" });
      await this._loadMatch(matchId);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || "校验失败", icon: "none" });
    }
  },

  // ── 阶段3：选择比赛结果 ──────────────────────────────────
  async onSelectResult(e) {
    const choice = e.currentTarget.dataset.choice;
    const { matchId, myChoice } = this.data;
    if (!matchId || myChoice) return;

    wx.showLoading({ title: "提交中..." });
    try {
      const result = await cloudDB.submitResultChoice(matchId, choice);
      wx.hideLoading();

      if (result.code === "conflict") {
        wx.showModal({
          title: "结果不一致",
          content: "你和对方选择的结果不同，请协商一致后再选择。",
          showCancel: false,
          confirmText: "知道了"
        });
        await this._loadMatch(matchId);
        return;
      }

      if (result.bothSelected) {
        wx.showToast({ title: "双方已选完，结算中...", icon: "none" });
      } else {
        wx.showToast({ title: "已提交，等待对方选择", icon: "success" });
      }
      await this._loadMatch(matchId);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || "提交失败", icon: "none" });
    }
  },

  // ── 辅助方法 ─────────────────────────────────────────────
  onShowRules() {
    wx.showModal({
      title: "约豆规则",
      content: `【约豆说明】\n\n加入即冻结 ${YUEDOU_FROZEN} 约豆\n\n【比赛结算】\n赢方：得 ${YUEDOU_WINNER} 约豆\n输方：扣 ${YUEDOU_LOSER} 约豆\n系统：抽 ${YUEDOU_SYSTEM} 约豆\n\n【冻结解冻】\n冻结约豆在结算后自动解冻`,
      showCancel: false
    });
  },

  getChoiceText(choice) {
    if (choice === "win")  return "我赢了";
    if (choice === "lose") return "我输了";
    return "—";
  }
});
