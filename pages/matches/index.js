const cloudDB = require("../../utils/cloudDB");
const { formatDateTime, playTypeLabel, costModeLabel } = require("../../utils/format");

// playType 映射：筛选值 → 数据库值
const PLAY_TYPE_MAP = {
  "不限": null,
  "八球": "eight_ball",
  "九球": "nine_ball",
  "斯诺克": "snooker"
};

// 获取用户当前位置（带权限检查，失败时给出提示）
function getUserLocation() {
  return new Promise((resolve) => {
    // 先检查定位权限状态
    wx.getSetting({
      success: (settingRes) => {
        const authSetting = settingRes.authSetting["scope.userLocation"];
        if (authSetting === false) {
          // 用户之前拒绝了授权
          wx.showToast({ title: "请开启位置权限查看附近球局", icon: "none", duration: 2500 });
          resolve(null);
          return;
        }
        if (authSetting === undefined) {
          // 从未申请过，发起授权申请
          wx.authorize({
            scope: "scope.userLocation",
            success: () => doGetLocation(resolve),
            fail: () => {
              wx.showToast({ title: "请允许位置权限", icon: "none", duration: 2500 });
              resolve(null);
            }
          });
        } else {
          // 已有权限，直接获取
          doGetLocation(resolve);
        }
      },
      fail: () => doGetLocation(resolve)
    });
  });
}

function doGetLocation(resolve) {
  wx.getLocation({
    type: "gcj02",
    success: (res) => resolve({ latitude: res.latitude, longitude: res.longitude }),
    fail: (err) => {
      console.warn("定位失败", err);
      resolve(null);
    }
  });
}

Page({
  data: {
    dayTab: "today",
    filters: {
      radiusKm: 3,
      playType: "不限"
    },
    // 原始数据缓存，供今日/明日前端切换
    _rawMatches: [],
    matches: [],
    loading: false
  },

  onLoad() {
    this._loadMatches();
  },

  onShow() {
    this._loadMatches();
  },

  async _loadMatches() {
    this.setData({ loading: true });

    try {
      const { filters } = this.data;
      const whereFilters = { status: "recruiting", startAtGte: Date.now() };

      // 玩法筛选
      const dbPlayType = PLAY_TYPE_MAP[filters.playType];
      if (dbPlayType) whereFilters.playType = dbPlayType;

      // 获取用户当前位置，用于计算距离
      const userLoc = await getUserLocation();

      const rawMatches = await cloudDB.getMatches(whereFilters);

      // 先标记无效局并计算距离
      const markedMatches = rawMatches.map((m) => {
        const hostNickname = m.hostNickname || m.host?.nickname || "";
        const joinedCount = m.headcountJoined ?? m.participants?.length ?? 0;
        const isInvalid = !hostNickname || joinedCount === 0 || (m.status && m.status !== "recruiting");

        // 解析球房位置：优先使用 venueLatitude/longitude（发布时直接存的）
        // 兼容 venueLocation（Geo.Point 或普通对象）
        let lat = m.venueLatitude ?? m._locationPlain?.latitude ?? null;
        let lon = m.venueLongitude ?? m._locationPlain?.longitude ?? null;
        if ((lat == null || lon == null) && m.venueLocation) {
          if (m.venueLocation.latitude != null) {
            lat = m.venueLocation.latitude;
            lon = m.venueLocation.longitude;
          } else if (m.venueLocation.coordinates) {
            lon = m.venueLocation.coordinates[0];
            lat = m.venueLocation.coordinates[1];
          }
        }

        // 计算到用户的距离
        let distanceText = "--";
        if (userLoc && lat != null && lon != null) {
          const km = cloudDB._calcDistance(userLoc.latitude, userLoc.longitude, lat, lon);
          distanceText = km.toFixed(1) + "km";
        }

        return {
          ...m,
          distanceText,
          startAtText: formatDateTime(m.startAt),
          playTypeText: playTypeLabel(m.playType),
          costModeText: costModeLabel(m.costMode || "aa"),
          hostNickname: hostNickname || "球友",
          isInvalid: isInvalid,
          statusText: m.status === "recruiting" ? "招募中" : m.status === "playing" ? "进行中" : m.status === "finished" ? "已结束" : "未知"
        };
      });

      // 无效局排到列表底部
      const validMatches = markedMatches.filter((m) => !m.isInvalid);
      const invalidMatches = markedMatches.filter((m) => m.isInvalid);
      const sortedMatches = [...validMatches, ...invalidMatches];

      // 缓存全量数据，切换今日/明日时前端过滤
      const filtered = this._filterByDay(sortedMatches, this.data.dayTab);
      this.setData({ _rawMatches: sortedMatches, matches: filtered, loading: false });
    } catch (e) {
      console.error("加载球局失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  // 根据今日/明日标签过滤数据
  _filterByDay(matches, dayTab) {
    const now = new Date();
    let startMs, endMs;

    if (dayTab === "today") {
      const s = new Date(now);
      s.setHours(0, 0, 0, 0);
      startMs = s.getTime();
      const e = new Date(s);
      e.setDate(e.getDate() + 1);
      endMs = e.getTime();
    } else {
      const s = new Date(now);
      s.setDate(s.getDate() + 1);
      s.setHours(0, 0, 0, 0);
      startMs = s.getTime();
      const e = new Date(s);
      e.setDate(e.getDate() + 1);
      endMs = e.getTime();
    }

    const validMatches = matches.filter((m) => !m.isInvalid && m.startAt >= startMs && m.startAt < endMs);
    const invalidMatches = matches.filter((m) => m.isInvalid && m.startAt >= startMs && m.startAt < endMs);
    return [...validMatches, ...invalidMatches];
  },

  // 切换今日/明日标签
  onSwitchDay(e) {
    const day = e.currentTarget.dataset.day;
    if (day === this.data.dayTab) return;
    const filtered = this._filterByDay(this.data._rawMatches, day);
    this.setData({ dayTab: day, matches: filtered });
  },

  onOpenFilters() {
    wx.showActionSheet({
      itemList: ["玩法：不限", "玩法：八球", "玩法：九球", "玩法：斯诺克"],
      success: (res) => {
        const idx = res.tapIndex;
        const next = { ...this.data.filters };

        if (idx === 0) next.playType = "不限";
        if (idx === 1) next.playType = "八球";
        if (idx === 2) next.playType = "九球";
        if (idx === 3) next.playType = "斯诺克";

        this.setData({ filters: next });
        this._loadMatches();
      }
    });
  },

  onGoPublish() {
    wx.navigateTo({ url: "/pages/publish/index" });
  },

  onOpenMatch(e) {
    const matchId = e.currentTarget.dataset.matchId;
    wx.navigateTo({ url: `/pages/match-detail/index?matchId=${encodeURIComponent(matchId)}` });
  }
});
