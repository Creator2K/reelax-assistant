// 每日签到插件：同时作为「如何写一个插件」的参考实现（见 docs/EXTENDING.md）
// 端点：GET /api/daily-check-in -> { checkedInToday, canClaim, ... }；POST /api/daily-check-in/claim
// 游戏日以北京时间（Asia/Shanghai）为界。与官方航线助手的「自动签到」互斥。
import { definePlugin } from "../core/plugin-host.js";
import { assertNoAssistantConflict, isSoftWarning } from "./_lib.js";

function beijingDate(offsetMs = 0) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(Date.now() + offsetMs));
}

export default definePlugin({
  id: "daily-checkin",
  name: "每日签到",
  version: "1.1.0",
  description: "每天自动领取签到奖励。北京时间零点后，跟随钓鱼同步或 10 分钟兜底轮询触发。",
  defaultEnabled: false,
  defaultConfig: {},
  configSchema: [],

  async onStart(ctx) {
    // 与官方航线助手冲突检测：助手开启且启用了「自动签到」时拒绝启动
    try {
      await assertNoAssistantConflict(ctx.api, "isAutoCheckInEnabled", "每日签到");
    } catch (err) {
      if (!isSoftWarning(err)) throw err;
      ctx.log.warn("每日签到", err.message);
    }

    ctx.state.doneDate = null;

    const tryClaim = async () => {
      const today = beijingDate(ctx.session.client.serverTimeOffset || 0);
      if (ctx.state.doneDate === today) return;
      try {
        const status = await ctx.api.dailyCheckInStatus();
        if (status?.checkedInToday || !status?.canClaim) {
          ctx.state.doneDate = today;
          ctx.log.info("每日签到", `今日已签到（连续 ${status?.currentStreak ?? "?"} 天）`);
          return;
        }
        const r = await ctx.api.dailyCheckInClaim();
        ctx.state.doneDate = today;
        const day = status?.nextRewardDay ?? "?";
        ctx.log.info("每日签到", `第 ${day} 天签到成功：${JSON.stringify(status?.rewards?.[day - 1] ?? r).slice(0, 200)}`);
      } catch (err) {
        const msg = String(err?.message || err);
        if (/已经签到|ALREADY|claimed/i.test(msg)) {
          ctx.state.doneDate = today;
        } else {
          ctx.log.warn("每日签到", `签到失败：${msg}`);
        }
      }
    };

    // 跟随钓鱼同步触发（保持在线引擎每 6 秒一次），外加 10 分钟兜底
    ctx.on("fishing:sync", tryClaim);
    ctx.every(10 * 60_000, tryClaim);
  },
});
