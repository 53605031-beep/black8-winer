const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  // 获取用户登录态
  const { OPENID, APPID } = cloud.getWXContext();

  return {
    openid: OPENID,
    appid: APPID,
    env: context.APPID
  };
};
