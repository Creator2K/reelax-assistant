# 扩展开发文档（插件系统）

辅助的能力全部由「插件」承载：内置的**保持在线**引擎是插件，签到也是插件。
你可以用同样的方式添加自己的功能——自动卖鱼、自动买 Buff、比赛报名、世界 Boss
提醒……只需要写**一个 JS 文件**，放进 `server/data/plugins/` 目录，重启服务即
自动加载，前端「插件中心」会自动生成配置界面。

---

## 1. 最小可用插件

在 `server/data/plugins/` 新建 `hello.js`：

```js
// server/data/plugins/hello.js
export default {
  id: "hello",                    // 全局唯一 ID（必填）
  name: "Hello 插件",
  version: "1.0.0",
  description: "每分钟打一条招呼日志，演示插件骨架。",
  defaultEnabled: false,          // 新会话是否默认启用
  defaultConfig: { name: "世界" },
  configSchema: [
    { key: "name", type: "string", label: "称呼", default: "世界", placeholder: "输入名字" },
  ],

  // 会话启动（且插件启用）时调用
  async onStart(ctx) {
    ctx.log.info("Hello", `你好，${ctx.config.name}！当前账号：${ctx.session.label}`);

    // 每 60s 执行一次（受管定时器，会话停止时自动清理）
    ctx.every(60_000, async () => {
      const me = await ctx.api.me();
      ctx.log.info("Hello", `${ctx.session.label} 的金币：${me.player.gold}`);
    });
  },

  // 会话停止时调用（清理自有资源；ctx.every/ctx.on 无需手动清理）
  async onStop(ctx) {},
};
```

重启服务（`npm run start` / Docker 重启）后：

1. 日志出现 `已注册插件：Hello 插件（hello）［外部］`
2. 打开控制台 → 会话详情 → 「会话插件」里出现开关与配置表单
3. 「插件中心」可修改默认配置

> 开发时可以直接改 `server/src/plugins/` 下的内置插件（保持在线、每日签到），
> 它们就是最完整的示例。

---

## 2. 插件定义字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 全局唯一标识，建议 kebab-case |
| `name` | string | ✅ | 显示名 |
| `description` | string | | 一句话说明，显示在插件卡片 |
| `version` | string | | 显示用 |
| `defaultEnabled` | boolean | | 新会话默认是否启用（默认 `false`） |
| `defaultConfig` | object | | 配置默认值 |
| `configSchema` | Field[] | | 配置表单描述，前端自动渲染 |
| `onStart(ctx)` | async fn | | 会话启动时调用 |
| `onStop(ctx)` | async fn | | 会话停止时调用 |
| `builtin` | boolean | | 由加载器自动设置（区分内置/外部），无需手写 |

### configSchema 字段类型

```js
{ key: "enabled",  type: "boolean", label: "启用",      hint: "开关下面的说明文字", default: true }
{ key: "count",    type: "number",  label: "数量",      default: 10, min: 1, max: 100, step: 1 }
{ key: "word",     type: "string",  label: "文本",      default: "", placeholder: "…" }
{ key: "note",     type: "textarea", label: "长文本",   default: "" }
{ key: "mode",     type: "select",  label: "下拉",      default: "a", options: [{ value: "a", label: "方案 A" }] }
```

配置修改后立即生效（`ctx.config` 是热更新的同一对象引用）。

---

## 3. ctx：插件运行时上下文

`onStart(ctx)` / `onStop(ctx)` 以及定时器、事件回调拿到的都是同一个 `ctx`：

| 成员 | 说明 |
| --- | --- |
| `ctx.session` | 会话运行时对象（`label` / `status` / `reportSync()` 等，见第 5 节） |
| `ctx.api` | **签名游戏客户端**（`GameClient`），见第 4 节 |
| `ctx.config` | 本会话的本插件配置（含默认值合并，热更新） |
| `ctx.state` | 插件私有草稿内存（重启引擎后清空，不持久化） |
| `ctx.log.info/warn/error/debug(tag, msg)` | 带会话与插件标签的结构化日志 |
| `ctx.on(event, handler)` | 订阅事件总线（会话维度过滤，自动清理） |
| `ctx.every(ms, fn)` | 受管定时器（自动清理，异步错误自动捕获到日志） |
| `ctx.schedule(ms, fn)` | 受管延时任务 |

---

## 4. ctx.api：签名游戏客户端

所有游戏请求已经处理好登录、签名、proof 续期、会话失效重登，直接调用即可：

```js
// 内置便捷方法
await ctx.api.fishingState();          // GET /api/fishing/state
await ctx.api.fishingStart();          // POST /api/fishing/start（幂等）
await ctx.api.fishingSync(key);        // POST /api/fishing/sync + 快照键头
await ctx.api.fishingRefill();         // POST /api/fishing/refill
await ctx.api.routeTravel();           // POST /api/route-assistant/travel
await ctx.api.dailyCheckInStatus();    // GET  /api/daily-check-in
await ctx.api.dailyCheckInClaim();     // POST /api/daily-check-in/claim
await ctx.api.inventoryFish();         // GET  /api/inventory/fish
await ctx.api.sellFish(items);         // POST /api/inventory/fish/sell
await ctx.api.me();

// 任意其他端点（自动签名）
await ctx.api.request("/api/shop/purchases", {
  method: "POST",
  body: { productId: "..." },
  idempotent: true,           // 自动生成 Idempotency-Key
});

// 辅助字段
ctx.api.player;                 // 最近一次知道的 player 对象
ctx.api.serverTimeOffset;       // 服务器时间校正（毫秒）
ctx.api.now();                  // 校正后的当前时间
```

> 内置插件就是最完整的调用范例：`keep-online`（钓鱼循环）、`auto-mastery`
> （专精献祭）、`auto-sell-fish`（背包分级 + 市场委托）、`auto-travel`（切图决策）。
> 完整便捷方法清单见 `server/src/core/client.js`；端点与请求格式见 `docs/PROTOCOL.md`。

错误处理：请求失败会抛 `GameClientError`（`.status` HTTP 状态码，`.code` 游戏错误码）。
签名过期（403 REQUEST_SIGNATURE_INVALID）与 Cookie 失效已由客户端内部自动处理，
插件只需关心业务错误。常用错误码：

| code / 特征 | 含义 | 建议 |
| --- | --- | --- |
| `NETWORK` | 网络失败 | 退避后重试 |
| `SESSION_EXPIRED` | Cookie 失效且无法重登 | 会话进入 expired，等待用户更新凭证 |
| `VALIDATION_ERROR` | 参数格式错误 | 检查请求体 |
| `NOT_FOUND` | 端点不存在 | 游戏版本更新了，对照 docs/PROTOCOL.md |

---

## 5. 事件总线

用 `ctx.on(event, handler)` 订阅。事件带 `sessionId`，插件宿主已按会话过滤，
只会收到自己会话的事件。

| 事件 | payload | 触发时机 |
| --- | --- | --- |
| `fishing:sync` | `{ sessionId, run, settlement }` | 保持在线引擎每次同步结算后 |
| `session:started` / `session:stopped` | `{ sessionId }` | 会话启停 |
| `session:status` | `{ sessionId, status }` | 状态变化 |
| `session:error` | `{ sessionId, message }` | 会话级错误 |

示例：卖掉所有背包里的鱼（谨慎使用！）

```js
ctx.on("fishing:sync", async ({ settlement }) => {
  if (!settlement?.fish?.length) return;
  const items = settlement.fish.map((f) => ({ fishId: f.fishId, quantity: f.quantity }));
  const r = await ctx.api.sellFish(items);
  ctx.log.info("auto-sell", `卖出 ${items.length} 种鱼，收入 ${r?.gold ?? "?"} 金币`);
});
```

---

## 6. 生命周期与安全边界

```
会话 start()
  └─ PluginHost.startSession(session)
       └─ 对每个注册插件：
            resolvePluginState()        决定 enabled + 合并配置
            （未启用则跳过）
            创建 ctx（api/config/log/state/受管定时器）
            await plugin.onStart(ctx)    ← 你的代码
            （onStart 抛错：该插件不启动，不影响其他插件与会话）

会话 stop()
  └─ await plugin.onStop(ctx) → 清空受管定时器与订阅
```

- 插件抛出的异步错误会被捕获并写入日志（`[error] [你的插件] ...`），不会拖垮引擎
- 需要访问控制台 HTTP 接口？外部插件可通过 `/api/...` 反向调用自己（带 token）
- **频率自律**：游戏客户端的天然节奏是 6 秒/杆；常规插件跟随 `fishing:sync`
  事件驱动即可，不要自行高频率轮询
- 账号安全：写操作（卖鱼、购买、加点）建议默认关闭 + 加二次确认配置

---

## 7. 实用模式

### 7.1 幂等 / 防重复

```js
// 状态放 ctx.state（引擎重启清空）或自己带 debounce
ctx.state.lastRunAt ??= 0;
if (Date.now() - ctx.state.lastRunAt < 60_000) return;
ctx.state.lastRunAt = Date.now();
```

### 7.2 用配置控制行为

```js
configSchema: [{ key: "minRarity", type: "select", label: "最低保留稀有度",
  default: "rare", options: [
    { value: "common", label: "普通及以上" },
    { value: "rare", label: "稀有及以上" },
] }]

// onStart 里读取
if (ctx.config.minRarity === "rare") { ... }
```

### 7.3 调试技巧

1. 打开控制台「运行日志」，过滤你的插件名
2. 手动触发：在会话详情里反复停/启引擎即可重跑 `onStart`
3. 协议层问题对照 `docs/PROTOCOL.md`，用 `curl` 单点验证端点

---

## 8. 打包与分发

- 内置插件：`server/src/plugins/*.js`，随代码仓库分发（`_` 开头的文件是共享库，不会被当作插件）
- 外部插件：`server/data/plugins/*.js`，运行时加载、不进版本库
- **控制台在线导入**：插件中心 →「导入插件」粘贴代码即可热加载（服务端会做语法与结构校验，
  失败不落盘）；外部插件卡片上有「卸载」按钮（停止实例并删除文件）
- 建议在插件文件头部用注释写明：功能、依赖端点、风险提示、兼容的游戏版本
- 插件可以在 `onStart` 里**抛错拒绝启动**（例如缺少前置条件），错误会显示在会话的
  插件列表中——内置的「自动卖鱼」就用它做了市场邮箱验证预检
