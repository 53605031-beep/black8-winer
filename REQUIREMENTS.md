# 约球8 — 产品需求文档（PRD）

> 本文档基于当前工程骨架编写，用于指导后续真实开发。
> 文档版本：v1.1 | 日期：2026-03-29

---

## 一、产品概述

**产品名称**：约球8
**产品类型**：微信小程序
**一句话描述**：帮助本地台球爱好者快速找到附近球房、发现/发起球局，并与球友高效组队到店开打。

**核心价值**：
- 减少沟通成本：用结构化"球局"替代零散聊天
- 提高匹配效率：按距离/时间/玩法/水平匹配
- 到店闭环：找球房 → 约局 → 到店确认 → 积分评价
- 福利激励：参与球局攒积分，约惠福利站

**目标用户**：
- 本地台球爱好者（主力用户）
- 球房经营者（商家侧，第二阶段）

---

## 二、产品现状总览

### 2.1 已完成页面

| 页面 | 路径 | 状态 | 说明 |
|------|------|------|------|
| 附近（球房列表） | `pages/nearby/` | 🟡 部分完成 | 列表展示 + 跳转详情，导航为骨架占位 |
| 球房详情 | `pages/venue-detail/` | 🟡 部分完成 | 信息展示 + 招募中球局，导航/发起约局为骨架 |
| 约局（球局列表） | `pages/matches/` | 🟡 部分完成 | 列表 + 筛选 UI，筛选逻辑为骨架 |
| 球局详情 | `pages/match-detail/` | 🟡 部分完成 | 参与人展示 + 积分录入（仅演示） |
| 发布约局 | `pages/publish/` | 🟡 部分完成 | 表单 UI 完整，发布为骨架 |
| 我的 | `pages/mine/` | 🟡 部分完成 | 个人数据展示，三个子功能均为骨架 |
| 排行榜 | `pages/leaderboard/` | ✅ 基本完成 | 前三名突出，其余排序，含积分/等级 |
| 商家入驻 | `pages/merchant-register/` | ✅ 基本完成 | 表单 + 提交逻辑，审核状态流转 |
| 管理员后台 | `pages/admin/` | ✅ 基本完成 | 审核列表 + 商户管理，通过/拒绝逻辑 |
| 用户众包添加球房 | `pages/venue-submit/` | ✅ 基本完成 | 轻量表单提交 |

### 2.2 现状总结

当前为**工程骨架 + 部分逻辑演示**阶段：

- ✅ **真实实现**：页面结构、UI 展示、mock 数据渲染、积分体系（录入+展示）、审核流转
- 🟡 **骨架占位**：发布成功、加入/退出球局、导航、定位、数据持久化
- ❌ **完全缺失**：登录态、真实后端 API、微信定位、订阅消息、支付

---

## 三、功能需求

### 3.1 第一阶段（MVP）——让球局真正跑通

#### 3.1.1 球房模块

| 功能 | 优先级 | 当前状态 | 需求说明 |
|------|--------|----------|----------|
| 球房列表展示 | P0 | 已完成 | 按距离排序，展示名称/距离/营业时间/标签 |
| 定位权限 + 距离计算 | P0 | ❌ 缺失 | 用户授权后计算真实距离；拒绝时降级为城市选择 |
| 球房详情页 | P0 | 已完成 | 展示完整信息 |
| 一键导航到店 | P0 | 🟡 骨架 | 接入 `wx.openLocation` 或三方地图调起 |
| 发起约局（从球房详情） | P0 | 已完成 | 预填球房 ID 跳转发布页 |

#### 3.1.2 球局模块

| 功能 | 优先级 | 当前状态 | 需求说明 |
|------|--------|----------|----------|
| 创建/发布球局 | P0 | 🟡 骨架 | 需接入 `matches` 数据持久化；发布后跳转到球局详情 |
| 球局列表（附近） | P0 | 已完成 | 展示招募中球局，含筛选 |
| 球局列表筛选 | P0 | 🟡 骨架 | 距离/时间/玩法/人数/水平/费用，筛选逻辑需真实实现 |
| 球局详情页 | P0 | 已完成 | 含参与人列表 |
| 加入/退出球局 | P0 | 🟡 骨架 | 需写入参与关系；加入后更新人数、通知发起人 |
| 时间冲突检测 | P1 | 🟡 骨架 | 加入时提示冲突球局，提供"仍要加入/返回" |
| 取消球局 | P1 | ❌ 缺失 | 发起人取消需填原因，通知所有参与者 |
| 球局状态流转 | P0 | 🟡 部分 | 当前只有 `finished` 状态；需实现 `recruiting → ongoing → ended` 流转 |

#### 3.1.3 我的球局模块

| 功能 | 优先级 | 当前状态 | 需求说明 |
|------|--------|----------|----------|
| 我发起的 | P0 | 🟡 骨架 | 列表展示，含状态管理入口（取消/开始/结束） |
| 我加入的 | P0 | 🟡 骨架 | 列表展示，支持到店确认 |
| 到店确认 | P0 | 🟡 骨架 | 参与者在临近开局时点"我已到店" |
| 编辑个人资料 | P1 | 🟡 骨架 | 玩法偏好/水平自评/常驻区域/隐私设置 |

#### 3.1.4 积分与等级体系

| 功能 | 优先级 | 当前状态 | 需求说明 |
|------|--------|----------|----------|
| 积分录入 | P0 | ✅ 已完成 | 发起人录入胜负方，实时更新积分 |
| 排行榜 | P0 | ✅ 已完成 | 前三突出，其余排序 |
| 等级展示 | P0 | ✅ 已完成 | 10 级体系（青铜→王者），每 10 分一级 |
| 约豆获取 | P0 | 🟡 骨架 | 比赛结束后根据规则发放约豆 |
| 福利站入口 | P0 | 🟡 骨架 | 球房详情页/我的页面入口 |
| 福利站商品展示 | P0 | 🟡 骨架 | 展示球房专属兑换商品 |
| 约豆兑换 | P0 | 🟡 骨架 | 用户用自己的约豆兑换福利 |
| 每日礼包 | P0 | 🟡 骨架 | 平台统一，每天一次 |
| 积分明细 | P1 | 🟡 骨架 | 查看积分来源与使用记录 |

#### 3.1.5 商家与审核体系

| 功能 | 优先级 | 当前状态 | 需求说明 |
|------|--------|----------|----------|
| 商家入驻申请 | P1 | ✅ 已完成 | 表单完整，提交后状态 `pending` |
| 管理员审核通过/拒绝 | P1 | ✅ 已完成 | 通过后状态变为 `approved` |
| 商户管理（下架/编辑） | P1 | 🟡 部分 | 编辑功能为骨架 |
| 用户众包添加球房 | P1 | ✅ 已完成 | 提交后状态 `pending` |

#### 3.1.6 通知模块

| 功能 | 优先级 | 当前状态 | 需求说明 |
|------|--------|----------|----------|
| 站内消息列表 | P1 | ❌ 缺失 | 用户消息中心，含红点未读数 |
| 加入/退出通知 | P1 | ❌ 缺失 | 有人加入/退出球局时通知发起人 |
| 开局前提醒 | P1 | ❌ 缺失 | 提前 1 小时提醒，可结合订阅消息 |
| 取消通知 | P1 | ❌ 缺失 | 取消时通知所有参与者 |

---

### 3.2 第二阶段 —— 提升成局率

| 功能 | 优先级 | 需求说明 |
|------|--------|----------|
| 智能推荐球局 | P2 | 按距离+时间+玩法+水平推荐 |
| 候补机制 | P2 | 满员后进入候补，有空位时依次通知 |
| 信誉分体系 | P2 | 爽约/临近退出扣分，影响排序和加入资格 |
| 球友评价 | P2 | 结束后互评守时/友好/球品 |
| 球房评价 | P2 | 结束后对球房打分（环境/服务/性价比） |

---

### 3.3 第三阶段 —— 商业化与增长

| 功能 | 优先级 | 需求说明 |
|------|--------|----------|
| 商家认领球房 | P3 | 商家认证后管理自己的球房 |
| 商家活动 | P3 | 优惠券/福利局/比赛活动 |
| 在线预订（谨慎） | P3 | 涉及支付，需合规审查 |

---

## 四、数据模型（字段规范）

### 4.1 用户（User）

| 字段 | 类型 | 说明 |
|------|------|------|
| userId | string | 唯一标识 |
| nickname | string | 微信昵称 |
| avatar | string | 微信头像 URL |
| score | number | 当前积分（用于排行榜和等级） |
| yueDou | number | 当前约豆（用于福利站兑换） |
| totalWin | number | 胜场数 |
| totalLose | number | 负场数 |
| playPreference | string[] | 玩法偏好 |
| skillLevel | string | 自评水平 |
| frequentArea | string | 常驻区域 |
| creditScore | number | 信誉分（第二阶段） |
| lastDailyGift | number | 上次领取每日礼包时间戳（用于判断是否已领） |

### 4.2 球房（Venue）

| 字段 | 类型 | 说明 |
|------|------|------|
| venueId | string | 唯一标识 |
| name | string | 球房名称 |
| address | string | 详细地址 |
| lat | number | 纬度 |
| lng | number | 经度 |
| distanceKm | number | 距用户距离 |
| openHours | string | 营业时间 |
| tags | string[] | 标签 |
| status | string | `approved` / `pending` / `rejected` |
| submittedBy | string | `user` / `merchant` / `admin` |
| submittedByUserId | string | 提交者 ID |
| submittedAt | number | 提交时间戳 |
| contactPhone | string | 商家电话 |
| description | string | 简介 |
| rating | number | 评分（第二阶段） |

### 4.3 球局（Match）

| 字段 | 类型 | 说明 |
|------|------|------|
| matchId | string | 唯一标识 |
| venueId | string | 关联球房 ID |
| startAt | number | 开始时间戳 |
| durationMinutes | number | 预计时长（枚举：60/90/120/180） |
| playType | string | `eight_ball` / `nine_ball` / `snooker` |
| headcountTarget | number | 目标人数 |
| headcountJoined | number | 已加入人数 |
| skillRequirement | string | 水平要求 |
| costMode | string | 费用方式 |
| status | string | `recruiting` / `ongoing` / `ended` / `cancelled` |
| host | object | 发起人 `{ userId, nickname }` |
| participants | object[] | 参与者列表 |
| results | object[] | 比赛结果（积分数据） |
| note | string | 补充说明 |

### 4.4 约豆记录（ScoreRecord）

| 字段 | 类型 | 说明 |
|------|------|------|
| recordId | string | 唯一标识 |
| userId | string | 用户 ID |
| venueId | string | 来源球房 ID |
| type | string | `match_win` / `match_draw` / `daily_gift` / `exchange` |
| amount | number | 约豆数量（正数为获得，负数为消耗） |
| matchId | string | 关联球局 ID（比赛获得时） |
| createdAt | number | 创建时间戳 |

### 4.5 福利站商品（Gift）

| 字段 | 类型 | 说明 |
|------|------|------|
| giftId | string | 唯一标识 |
| venueId | string | 所属球房 ID |
| name | string | 商品名称 |
| description | string | 商品描述 |
| image | string | 商品图片 |
| price | number | 所需约豆数量 |
| stock | number | 库存数量 |
| status | string | `active` / `inactive` |
| createdAt | number | 创建时间 |

### 4.4 消息（Notification）

| 字段 | 类型 | 说明 |
|------|------|------|
| notificationId | string | 唯一标识 |
| userId | string | 接收者 |
| type | string | `join` / `leave` / `cancel` / `reminder` |
| matchId | string | 关联球局 |
| content | string | 消息内容 |
| read | boolean | 是否已读 |
| createdAt | number | 创建时间 |

---

## 五、页面清单与交互规范

### 5.1 页面列表

| 页面 | 路径 | Tab | 说明 |
|------|------|-----|------|
| 附近（球房列表） | `pages/nearby/index` | ✅ Tab | 底部 Tab 第 1 项 |
| 约局（球局列表） | `pages/matches/index` | ✅ Tab | 底部 Tab 第 2 项 |
| 发布约局 | `pages/publish/index` | ✅ Tab | 底部 Tab 第 3 项 |
| 我的 | `pages/mine/index` | ✅ Tab | 底部 Tab 第 4 项 |
| 球房详情 | `pages/venue-detail/index` | ❌ 非 Tab | 从附近列表进入，含福利站入口 |
| 球局详情 | `pages/match-detail/index` | ❌ 非 Tab | 从约局列表/球房详情进入 |
| 排行榜 | `pages/leaderboard/index` | ❌ 非 Tab | 从我的进入 |
| 商家入驻 | `pages/merchant-register/index` | ❌ 非 Tab | 从我的进入 |
| 管理员后台 | `pages/admin/index` | ❌ 非 Tab | 从我的进入 |
| 用户众包添加 | `pages/venue-submit/index` | ❌ 非 Tab | 从附近进入 |
| 福利站 | `pages/welfare/index` | ❌ 非 Tab | 从球房详情/我的进入 |

### 5.2 积分与福利体系规则

#### 5.2.1 约豆规则

| 来源 | 数量 | 说明 |
|------|------|------|
| 赢得比赛 | +10 | 每赢一场获得 10 约豆 |
| 平局 | +5 | 每平一场获得 5 约豆 |
| 每日礼包 | +5 | 平台统一，每天一次 |
| 兑换商品 | -X | 消耗对应数量约豆 |

#### 5.2.2 兑换规则

- 用户只能在**产生过约豆的球房**兑换福利
- 每个球房的福利站独立，用户能看到自己"可兑换"的球房列表
- 兑换时检查该球房的约豆余额是否足够

#### 5.2.3 每日礼包规则

- 平台统一，**每天只能领取一次**
- 判断依据：`lastDailyGift` 时间戳是否为当天
- 领取后更新 `lastDailyGift` 时间戳

### 5.2 交互规范

**首次进入授权流程**：
1. 展示定位说明页，解释为何需要定位
2. 用户授权 → 进入首页，按定位排序
3. 用户拒绝 → 降级为手动选择城市/区域，显示默认球房列表
4. 提供入口：设置 → 重新开启定位

**球局创建默认值（MVP）**：
- 开局时间 = 当前 + 60 分钟
- 时长 = 90 分钟
- 人数 = 2 人
- 水平 = 不限
- 费用 = AA

**球局状态交互**：

| 状态 | 发起人可见 | 参与者可见 |
|------|-----------|-----------|
| recruiting | 加入列表 / 编辑 / 取消 | 加入 / 退出 / 时间冲突提示 |
| ongoing | 结束球局 / 到店管理 | 到店确认 |
| ended | 录入结果 / 评分入口 | 评分入口 |
| cancelled | 取消原因 | 取消原因 |

---

## 六、技术需求

### 6.1 技术选型

| 层 | 方案 | 说明 |
|----|------|------|
| 前端 | 微信小程序原生 | WXML + WXSS + JS，当前骨架已采用 |
| 数据层 | 微信云开发 / 自建后端 | MVP 建议微信云开发，快速上线 |
| 登录 | 微信授权登录 | `wx.login()` 获取 code，换 sessionToken |
| 定位 | 微信定位 | `wx.getLocation()`，拒绝时降级 |
| 消息推送 | 订阅消息 | `wx.requestSubscribeMessage`，需用户授权 |
| 地图导航 | `wx.openLocation` | 内置地图调起，支持高德/腾讯/百度 |
| 支付 | 微信支付 | 第三阶段考虑，需商户资质 |

### 6.2 接口清单（MVP）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | POST | 微信登录，换 session |
| `/api/me` | GET | 获取当前用户信息 |
| `/api/me` | PATCH | 更新个人资料 |
| `/api/venues` | GET | 附近球房列表（含距离筛选） |
| `/api/venues/:id` | GET | 球房详情 |
| `/api/matches` | GET | 球局列表（含多维筛选） |
| `/api/matches` | POST | 创建球局 |
| `/api/matches/:id` | GET | 球局详情 |
| `/api/matches/:id` | PATCH | 修改球局（发起人） |
| `/api/matches/:id/cancel` | POST | 取消球局 |
| `/api/matches/:id/join` | POST | 加入球局 |
| `/api/matches/:id/leave` | POST | 退出球局 |
| `/api/matches/:id/checkin` | POST | 到店确认 |
| `/api/me/matches` | GET | 我的球局（发起/加入） |
| `/api/me/notifications` | GET | 消息列表 |
| `/api/admin/venues/pending` | GET | 待审核球房（管理员） |
| `/api/admin/venues/:id/approve` | POST | 审核通过 |
| `/api/admin/venues/:id/reject` | POST | 审核拒绝 |
| `/api/merchant/venues` | POST | 商家提交入驻 |
| `/api/leaderboard` | GET | 排行榜 |

### 6.3 错误码规范

| 错误码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1000 | 未知错误 |
| 1001 | 未登录 / 登录态失效 |
| 1002 | 参数错误（表单校验） |
| 1003 | 权限不足 |
| 1004 | 资源不存在 |
| 1005 | 频率限制 |
| 1006 | 服务不可用 |

---

## 七、非功能性需求

### 7.1 合规与隐私

- 用户昵称/头像：使用微信授权数据，不存储敏感信息
- 联系方式：默认不展示；商家入驻电话仅管理员可见
- 举报机制：第二阶段实现
- 内容过滤：创建球局时过滤联系方式/敏感词

### 7.2 性能与体验

- 页面首次加载 < 2 秒（骨架 + mock 数据已满足）
- 列表页下拉刷新体验流畅
- 表单提交有 loading 状态和成功/失败反馈
- 空列表/空结果页有引导文案

### 7.3 可运营指标

| 指标 | 说明 |
|------|------|
| 每周完成球局数 | 北极星指标 |
| 成局率 | 发布球局中最终至少 2 人参与的比例 |
| 取消率 | cancelled / created |
| 临近退出率 | 距离开局 < 1 小时退出占比 |

---

## 八、开发优先级与排期建议

### 冲刺 1（MVP 核心闭环，约 2 周）

目标：用户能完整走一遍"找球房 → 发布球局 → 有人加入 → 到店 → 录入结果"全流程。

1. 接入微信云开发环境，创建数据库集合
2. 将 mock 数据迁移到云数据库
3. 实现登录态（微信授权）
4. 实现定位与真实距离计算
5. 球局 CRUD（创建/列表/详情/修改/取消）
6. 加入/退出球局逻辑
7. 球局状态流转（recruiting → ongoing → ended）
8. 到店确认
9. 积分录入与实时更新
10. 我的球局（我发起/我加入）

### 冲刺 2（审核与商家体系，约 1 周）

11. 商家入驻表单数据落地
12. 用户众包添加球房数据落地
13. 管理员审核/拒绝/管理逻辑
14. 站内消息通知（加入/退出/取消）
15. 开局前提醒（订阅消息）

### 冲刺 3（体验提升，约 1 周）

16. 球局筛选逻辑真实实现
17. 时间冲突检测
18. 编辑个人资料页
19. 空态/异常态 UI 优化
20. 全局 loading / 错误处理

---

## 九、当前骨架待完善清单

以下为当前代码中标注为"骨架/待实现"的完整清单，供逐条跟进：

```
pages/nearby/index.js
  - onNav()：接入 wx.openLocation 真实导航

pages/venue-detail/index.js
  - onNav()：接入 wx.openLocation 真实导航
  - onPublishFromVenue()：发布成功后真实创建球局

pages/matches/index.js
  - onOpenFilters()：筛选逻辑真实实现并过滤列表

pages/match-detail/index.js
  - onJoin()：真实写入参与关系
  - onLeave()：真实删除参与关系
  - onCheckin()：真实写入到店状态

pages/publish/index.js
  - onPublish()：真实创建球局并跳转详情

pages/mine/index.js
  - onEditProfile()：完整编辑资料页
  - onMyHosted()：真实展示我发起的球局
  - onMyJoined()：真实展示我加入的球局
  - onGoMatches()：真实跳转到约局列表

pages/admin/index.js
  - onEditVenue()：完整编辑球房功能

utils/mock.js
  - 将所有 mock 数据替换为云数据库调用

pages/welfare/index.js（新增）
  - onLoad()：获取当前球房 ID，加载该球房福利商品列表
  - onExchange()：检查约豆余额，扣除并兑换

pages/venue-detail/index.js
  - 福利站入口：进入福利站页面

pages/match-detail/index.js
  - onSubmitResult()：比赛结束后发放约豆（赢家+10，平局+5）

pages/mine/index.js
  - 每日礼包入口：检查是否已领取，未领取则领取
  - 积分明细入口：查看约豆来源记录
```

---

*本文档随开发进展持续更新。每次 sprint 结束后更新"当前骨架待完善清单"。*
