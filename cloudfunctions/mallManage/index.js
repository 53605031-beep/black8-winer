/**
 * 约球8 · 商城管理云函数
 *
 * 商品、兑换订单属于后台数据，不能相信前端传来的 openid 或页面入口判断。
 * 这里统一用微信云端给出的 OPENID 做管理员/商家身份校验。
 */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 与 app.js / adminMerchant 云函数里的管理员列表保持一致。
const ADMIN_OPENIDS = ["oT1J31-mApAYh__uGecWXOU4KvaA"];

function isAdmin(openid) {
  return ADMIN_OPENIDS.includes(openid);
}

async function getUser(openid) {
  const res = await db.collection("yueqiu8_users").where({ openid }).get();
  return res.data[0] || null;
}

async function requireAdmin(openid) {
  if (!isAdmin(openid)) throw new Error("无管理员权限");
}

async function requireVenueManager(openid, venueId) {
  if (isAdmin(openid)) return { role: "admin" };
  if (!venueId) throw new Error("无商家权限");

  const user = await getUser(openid);
  if (user?.role === "merchant" && user.merchantVenueId === venueId) {
    return { role: "merchant", venueId };
  }

  throw new Error("无商家权限");
}

function normalizeGoodsData(goodsData, forcedVenueId) {
  const source = goodsData || {};
  const data = {
    name: String(source.name || "").trim(),
    description: String(source.description || ""),
    image: String(source.image || ""),
    price: parseInt(source.price, 10) || 0,
    stock: parseInt(source.stock, 10) || 0,
    category: source.category || "physical",
    currencyType: source.currencyType || "score",
    venueId: forcedVenueId !== undefined ? forcedVenueId : (source.venueId || null),
    sort: parseInt(source.sort, 10) || 0,
    status: source.status || "active",
    updatedAt: db.serverDate()
  };

  if (!data.name) throw new Error("请填写商品名称");
  if (data.price <= 0) throw new Error("请填写正确的价格");
  if (!["physical", "virtual"].includes(data.category)) data.category = "physical";
  if (!["yuedou", "score"].includes(data.currencyType)) data.currencyType = "score";
  if (!["active", "inactive"].includes(data.status)) data.status = "active";
  return data;
}

async function listAllGoods(openid) {
  await requireAdmin(openid);
  const { data } = await db.collection("mall_goods")
    .orderBy("sort", "asc")
    .orderBy("createdAt", "desc")
    .get();
  return { data };
}

async function listAdminRedemptions(openid, status) {
  await requireAdmin(openid);
  const where = status ? { status } : {};
  const { data } = await db.collection("mall_redemptions")
    .where(where)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return { data };
}

async function listFulfillment(openid) {
  await requireAdmin(openid);
  const { data } = await db.collection("mall_redemptions")
    .where(_.or([{ status: "pending" }, { status: "shipped" }]))
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return { data };
}

async function listVenueGoods(openid, venueId) {
  await requireVenueManager(openid, venueId);
  const { data } = await db.collection("mall_goods")
    .where({ venueId })
    .orderBy("sort", "asc")
    .orderBy("createdAt", "desc")
    .get();
  return { data };
}

async function listVenueRedemptions(openid, venueId) {
  await requireVenueManager(openid, venueId);
  const { data } = await db.collection("mall_redemptions")
    .where({ venueId })
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return { data };
}

async function saveGoods(openid, goodsData, goodsId) {
  let forcedVenueId;
  if (goodsId) {
    const current = (await db.collection("mall_goods").doc(goodsId).get()).data;
    if (!current) throw new Error("商品不存在");
    await requireVenueManager(openid, current.venueId || null);
    const hasVenueId = Object.prototype.hasOwnProperty.call(goodsData || {}, "venueId");
    forcedVenueId = isAdmin(openid)
      ? (hasVenueId ? (goodsData.venueId || null) : (current.venueId || null))
      : current.venueId;
  } else {
    const requestedVenueId = goodsData?.venueId || null;
    await requireVenueManager(openid, requestedVenueId);
    forcedVenueId = isAdmin(openid) ? requestedVenueId : requestedVenueId;
  }

  const data = normalizeGoodsData(goodsData, forcedVenueId);
  if (goodsId) {
    await db.collection("mall_goods").doc(goodsId).update({ data });
    return { goodsId };
  }

  data.createdAt = db.serverDate();
  const result = await db.collection("mall_goods").add({ data });
  return { goodsId: result._id };
}

async function deleteGoods(openid, goodsId) {
  if (!goodsId) throw new Error("缺少商品ID");
  const goods = (await db.collection("mall_goods").doc(goodsId).get()).data;
  if (!goods) throw new Error("商品不存在");
  await requireVenueManager(openid, goods.venueId || null);
  await db.collection("mall_goods").doc(goodsId).remove();
  return { ok: true };
}

async function updateRedemptionStatus(openid, redemptionId, status) {
  if (!redemptionId) throw new Error("缺少兑换记录ID");
  if (!["pending", "shipped", "completed"].includes(status)) {
    throw new Error("无效的订单状态");
  }

  const redemption = (await db.collection("mall_redemptions").doc(redemptionId).get()).data;
  if (!redemption) throw new Error("兑换记录不存在");
  await requireVenueManager(openid, redemption.venueId || null);

  await db.collection("mall_redemptions").doc(redemptionId).update({
    data: { status, updatedAt: db.serverDate() }
  });
  return { ok: true };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, errMsg: "无法获取用户身份" };

  const { action, goodsData, goodsId, redemptionId, status, venueId } = event || {};
  try {
    switch (action) {
      case "getAllGoods":
        return { ok: true, ...(await listAllGoods(OPENID)) };
      case "getAllRedemptions":
        return { ok: true, ...(await listAdminRedemptions(OPENID, status)) };
      case "getRedemptionsForFulfillment":
        return { ok: true, ...(await listFulfillment(OPENID)) };
      case "getMyVenueGoods":
        return { ok: true, ...(await listVenueGoods(OPENID, venueId)) };
      case "getMyVenueRedemptions":
        return { ok: true, ...(await listVenueRedemptions(OPENID, venueId)) };
      case "saveGoods":
        return { ok: true, ...(await saveGoods(OPENID, goodsData, goodsId)) };
      case "deleteGoods":
        return { ok: true, ...(await deleteGoods(OPENID, goodsId)) };
      case "updateRedemptionStatus":
        return { ok: true, ...(await updateRedemptionStatus(OPENID, redemptionId, status)) };
      default:
        return { ok: false, errMsg: "未知操作: " + action };
    }
  } catch (e) {
    console.error(`mallManage[${action}] error`, e);
    return { ok: false, errMsg: e.message || String(e) };
  }
};
