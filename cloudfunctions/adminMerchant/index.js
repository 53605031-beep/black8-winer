/**
 * 管理员：商家入驻审批（通过 / 拒绝）
 * 必须在云函数里写库：客户端「仅创建者可读写」时，管理员无法改申请人创建的 venues 记录。
 *
 * 【重要】下方 ADMIN_OPENIDS 须与小程序 app.js 里 globalData.adminOpenids 保持完全一致，
 * 改任一处后请同步另一处，并重新「上传并部署」本云函数。
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 与 app.js → globalData.adminOpenids 同步
const ADMIN_OPENIDS = ["oT1J31-mApAYh__uGecWXOU4KvaA"];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!ADMIN_OPENIDS.includes(OPENID)) {
    return { ok: false, errMsg: "无管理员权限" };
  }

  const { action, appId, reason } = event || {};
  if (!appId) {
    return { ok: false, errMsg: "缺少申请ID" };
  }

  if (action === "approve") {
    return approveApplication(appId);
  }
  if (action === "reject") {
    return rejectApplication(appId, reason);
  }

  return { ok: false, errMsg: "未知操作" };
};

async function approveApplication(appId) {
  try {
    const appRes = await db.collection("merchant_applications").doc(appId).get();
    const app = appRes.data;
    if (!app) return { ok: false, errMsg: "申请不存在" };
    if (!app.venueId) return { ok: false, errMsg: "申请缺少关联球房ID" };

    const venueBefore = await db.collection("venues").doc(app.venueId).get();
    if (!venueBefore.data) {
      return { ok: false, errMsg: "关联球房不存在，venueId=" + app.venueId };
    }

    await db.collection("venues").doc(app.venueId).update({
      data: { status: "active" }
    });

    await db.collection("merchant_applications").doc(appId).update({
      data: { status: "approved", processedAt: db.serverDate() }
    });

    let merchantVenueName = "我的球房";
    const venueSnap = await db.collection("venues").doc(app.venueId).get();
    if (venueSnap.data && venueSnap.data.name) {
      merchantVenueName = venueSnap.data.name;
    }

    await db.collection("yueqiu8_users").where({ openid: app.applicantOpenid }).update({
      data: { role: "merchant", merchantVenueId: app.venueId, merchantVenueName }
    });

    await db.collection("notices").add({
      data: {
        type: "merchant_approved",
        targetOpenid: app.applicantOpenid,
        venueId: app.venueId,
        content: `你的入驻申请已通过，球房「${app.venueName}」已上线！`,
        createdAt: db.serverDate(),
        isRead: false
      }
    });

    return { ok: true, venueId: app.venueId };
  } catch (e) {
    console.error("approveApplication", e);
    return { ok: false, errMsg: e.message || String(e) };
  }
}

async function rejectApplication(appId, reason) {
  const text = reason && String(reason).trim() ? String(reason).trim() : "不符合入驻条件";
  try {
    const appRes = await db.collection("merchant_applications").doc(appId).get();
    const app = appRes.data;
    if (!app) return { ok: false, errMsg: "申请不存在" };

    if (app.venueId) {
      await db.collection("venues").doc(app.venueId).update({
        data: { status: "rejected" }
      });
    }

    await db.collection("merchant_applications").doc(appId).update({
      data: { status: "rejected", rejectReason: text, processedAt: db.serverDate() }
    });

    await db.collection("notices").add({
      data: {
        type: "merchant_rejected",
        targetOpenid: app.applicantOpenid,
        content: `你的入驻申请被拒绝：${text}`,
        createdAt: db.serverDate(),
        isRead: false
      }
    });

    return { ok: true };
  } catch (e) {
    console.error("rejectApplication", e);
    return { ok: false, errMsg: e.message || String(e) };
  }
}
