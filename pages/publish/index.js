const cloudDB = require("../../utils/cloudDB");

// 星期文案
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// 生成往后 N 天的日期选项，左列用
function buildDateOptions(days = 14) {
  const result = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const wd = WEEKDAY[d.getDay()];
    let label;
    if (i === 0) label = `今天(${wd})`;
    else if (i === 1) label = `明天(${wd})`;
    else label = `${mm}-${dd}(${wd})`;
    result.push({ date: `${yyyy}-${mm}-${dd}`, label, dayIndex: i });
  }
  return result;
}

// 全天 30 分钟档（明天及以后使用）
function buildFullTimeSlots() {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
}

// 今天专用：从当前时间向上取整到 30 分钟档开始，到 23:30
function buildTodayTimeSlots() {
  const now = new Date();
  const curMins = now.getHours() * 60 + now.getMinutes();
  // 向上取整到下一个 30 分钟档
  const startMins = Math.ceil(curMins / 30) * 30;
  const slots = [];
  // 如果刚好整点（如 9:00），也需要包含 9:00 这一档
  for (let mins = startMins; mins < 24 * 60; mins += 30) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  // 处理边界：现在恰好是 xx:30 时，向上取整会跳到下一个整点，
  // 但用户可能仍想选当前这一档（如 9:30），所以兜底补上当前分钟所在档（若不在slots中）
  if (slots.length === 0) {
    const h = Math.floor(curMins / 60);
    const m = curMins % 60;
    slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return slots;
}

// 把 "HH:MM" 字符串转成当天的"分钟数"（从 0 点起）
function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// 取当前时间，向上取整到下一个整 30 分钟
function getDefaultTime() {
  const now = new Date();
  const curMins = now.getHours() * 60 + now.getMinutes();
  const rounded = Math.ceil((curMins + 30) / 30) * 30;
  const h = Math.floor(rounded % 1440 / 60);
  const m = rounded % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// 格式化显示文案：今天 15:00 / 03-30 14:30
function formatDisplayTime(date, time) {
  const [yyyy, mm, dd] = date.split("-").map(Number);
  const d = new Date(yyyy, mm - 1, dd);
  const wd = WEEKDAY[d.getDay()];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(yyyy, mm - 1, dd);
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  return `${mm}-${dd}(${wd}) ${time}`;
}

// 根据 dayIndex 返回对应的时间列表
function getTimeSlotsForDay(dayIndex) {
  if (dayIndex === 0) {
    return buildTodayTimeSlots();
  }
  return buildFullTimeSlots();
}

// 在指定时间列表中找到指定时间的下标，找不到则返回 0
function findTimeIdx(slots, time) {
  const idx = slots.indexOf(time);
  return idx >= 0 ? idx : 0;
}

const FULL_TIME_SLOTS = buildFullTimeSlots();
const DATE_OPTIONS = buildDateOptions(2); // 只显示今天和明天

Page({
  data: {
    venueOptions: [],
    venueIndex: 0,

    // 比赛时间
    date: "",
    time: "",
    displayTime: "",
    dateOptions: DATE_OPTIONS,
    // 弹层中实际渲染的时间列表（随日期动态变化）
    timeSlots: buildTodayTimeSlots(),

    // 弹层状态
    showTimeSheet: false,
    curDateIdx: 0,
    curTimeIdx: 0,

    durationOptions: [60, 90, 120, 180],
    durationIndex: 1,

    playTypeOptions: [
      { value: "eight_ball", label: "八球" },
      { value: "nine_ball", label: "九球" },
      { value: "snooker", label: "斯诺克" }
    ],
    playTypeIndex: 0,

    roundsOptions: [
      { value: 5, label: "抢五" },
      { value: 7, label: "抢七" },
      { value: 9, label: "抢九" }
    ],
    roundsIndex: 0,

    frozenBeans: cloudDB.YUEDOU_FROZEN,
    winBeans: cloudDB.YUEDOU_WINNER,
    loseBeans: cloudDB.YUEDOU_LOSER,

    agreed: false,
    loadingVenues: false,
    publishing: false
  },

  onShow() {
    this._loadVenues();

    const draftVenueId = wx.getStorageSync("draft.match.venueId");
    if (draftVenueId) {
      const idx = this.data.venueOptions.findIndex((v) => v._id === draftVenueId || v.venueId === draftVenueId);
      if (idx >= 0) this.setData({ venueIndex: idx });
      wx.removeStorageSync("draft.match.venueId");
    }
  },

  async _loadVenues() {
    this.setData({ loadingVenues: true });
    try {
      const venues = await cloudDB.getVenues(null);
      this.setData({ venueOptions: venues, loadingVenues: false });

      const draftVenueId = wx.getStorageSync("draft.match.venueId");
      if (draftVenueId) {
        const idx = venues.findIndex((v) => v._id === draftVenueId || v.venueId === draftVenueId);
        if (idx >= 0) this.setData({ venueIndex: idx });
        wx.removeStorageSync("draft.match.venueId");
      }
    } catch (e) {
      console.error("加载球房列表失败", e);
      this.setData({ loadingVenues: false });
    }
  },

  onLoad() {
    const todaySlots = buildTodayTimeSlots();
    const defaultTime = getDefaultTime();
    const date = DATE_OPTIONS[0].date;
    const displayTime = formatDisplayTime(date, defaultTime);
    this.setData({
      date,
      time: defaultTime,
      displayTime,
      timeSlots: todaySlots,
      curDateIdx: 0,
      curTimeIdx: findTimeIdx(todaySlots, defaultTime)
    });
  },

  // ========== 时间选择弹层 ==========

  onOpenTimeSheet() {
    const { date, time } = this.data;
    const { dateOptions } = this.data;
    const dateIdx = dateOptions.findIndex((d) => d.date === date);
    const dayIndex = dateIdx >= 0 ? dateOptions[dateIdx].dayIndex : 0;

    // 根据当前选中日期决定时间列表
    const slots = getTimeSlotsForDay(dayIndex);
    let timeIdx = findTimeIdx(slots, time);

    // 若当前选中时间早于今天第一档（用户点了"今天"但 time 是旧数据），自动跳到第一档
    if (dayIndex === 0) {
      const todayFirst = slots[0];
      if (timeToMinutes(time) < timeToMinutes(todayFirst)) {
        timeIdx = 0;
      }
    }

    this.setData({
      showTimeSheet: true,
      timeSlots: slots,
      curDateIdx: dateIdx >= 0 ? dateIdx : 0,
      curTimeIdx: timeIdx
    });
  },

  onDateColTap(e) {
    const newDateIdx = Number(e.currentTarget.dataset.idx);
    const { dateOptions } = this.data;
    const dayIndex = dateOptions[newDateIdx].dayIndex;

    // 切换日期时，同步切换时间列表
    const slots = getTimeSlotsForDay(dayIndex);
    const { time } = this.data;
    let timeIdx = findTimeIdx(slots, time);

    // 明天及以后切回"今天"时，如果当前选中的时间早于今天第一档，夹到第一档
    if (dayIndex === 0) {
      const todayFirst = slots[0];
      if (timeToMinutes(time) < timeToMinutes(todayFirst)) {
        timeIdx = 0;
      }
    }

    this.setData({
      curDateIdx: newDateIdx,
      timeSlots: slots,
      curTimeIdx: timeIdx
    });
  },

  onTimeColTap(e) {
    this.setData({ curTimeIdx: Number(e.currentTarget.dataset.idx) });
  },

  onTimeSheetConfirm() {
    const { dateOptions, timeSlots, curDateIdx, curTimeIdx } = this.data;
    const date = dateOptions[curDateIdx].date;
    const time = timeSlots[curTimeIdx];
    const displayTime = formatDisplayTime(date, time);
    this.setData({
      date,
      time,
      displayTime,
      showTimeSheet: false
    });
  },

  onCloseTimeSheet() {
    this.setData({ showTimeSheet: false });
  },

  // ========== 其他 ==========

  onVenueChange(e) {
    this.setData({ venueIndex: Number(e.detail.value) });
  },

  onDurationChange(e) {
    this.setData({ durationIndex: Number(e.detail.value) });
  },

  onPlayTypeChange(e) {
    this.setData({ playTypeIndex: Number(e.detail.value) });
  },

  onRoundsChange(e) {
    this.setData({ roundsIndex: Number(e.detail.value) });
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  onReset() {
    const todaySlots = buildTodayTimeSlots();
    const defaultTime = getDefaultTime();
    const date = DATE_OPTIONS[0].date;
    const displayTime = formatDisplayTime(date, defaultTime);
    this.setData({
      venueIndex: 0,
      date,
      time: defaultTime,
      displayTime,
      timeSlots: todaySlots,
      curDateIdx: 0,
      curTimeIdx: findTimeIdx(todaySlots, defaultTime),
      durationIndex: 1,
      playTypeIndex: 0,
      roundsIndex: 0,
      agreed: false
    });
    wx.showToast({ title: "已重置", icon: "success" });
  },

  async onPublish() {
    const venue = this.data.venueOptions[this.data.venueIndex];
    if (!venue) {
      wx.showToast({ title: "请选择球房", icon: "none" });
      return;
    }

    // 禁止同时发起多个活跃球局
    const activeMatches = await cloudDB.getMyActiveMatches();
    if (activeMatches.length > 0) {
      const m = activeMatches[0];
      const statusText = m.status === "recruiting" ? "招募中" : "进行中";
      wx.showModal({
        title: "已有进行中的球局",
        content: `你当前在「${m.venueName}」有一个${statusText}的球局，请先结束后再发起新的，避免时间冲突哦~`,
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }

    // 检查约豆是否充足
    const me = await cloudDB.getCurrentUser();
    const yuedou = me?.yuedou ?? 0;
    if (yuedou < cloudDB.YUEDOU_FROZEN) {
      wx.showModal({
        title: "约豆不足",
        content: `发起约局需冻结 ${cloudDB.YUEDOU_FROZEN} 约豆，你当前只有 ${yuedou} 约豆。\n请先获取更多约豆后再发起。`,
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }

    wx.showModal({
      title: "确认发布",
      content: `发布后自动冻结 ${cloudDB.YUEDOU_FROZEN} 约豆。\n赢方得 ${cloudDB.YUEDOU_WINNER}，组局成功消耗 ${cloudDB.YUEDOU_SYSTEM}，输方扣 ${cloudDB.YUEDOU_LOSER}。\n\n确认发布吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        await this._doPublish(venue);
      }
    });
  },

  async _doPublish(venue) {
    this.setData({ publishing: true });
    wx.showLoading({ title: "发布中..." });

    try {
      const startAt = this._buildTimestamp(this.data.date, this.data.time);

      await cloudDB.publishMatch({
        venueId: venue._id || venue.venueId,
        venueName: venue.name,
        venueLocation: venue.location,
        venueLatitude: venue.location?.latitude ?? venue._locationPlain?.latitude,
        venueLongitude: venue.location?.longitude ?? venue._locationPlain?.longitude,
        startAt,
        durationMinutes: this.data.durationOptions[this.data.durationIndex],
        playType: this.data.playTypeOptions[this.data.playTypeIndex].value,
        matchRounds: this.data.roundsOptions[this.data.roundsIndex].value,
        // MVP 默认值：目标人数2人，费用AA
        headcountTarget: 2,
        costMode: "aa"
      });

      wx.hideLoading();
      wx.showToast({ title: "发布成功！冻结500约豆", icon: "success" });
      setTimeout(() => wx.switchTab({ url: "/pages/matches/index" }), 1500);
    } catch (e) {
      wx.hideLoading();
      console.error("发布失败", e);
      wx.showToast({ title: "发布失败：" + (e.message || "请重试"), icon: "none" });
      this.setData({ publishing: false });
    }
  },

  _buildTimestamp(date, time) {
    return new Date(`${date}T${time}:00`).getTime();
  }
});
