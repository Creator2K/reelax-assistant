// 保持在线插件：自动开始/维持在线钓鱼循环
//
// 工作原理（详见 docs/PROTOCOL.md）：
//  - 游戏的在线模式由客户端驱动：POST /api/fishing/start 开启一轮（200 杆 × cycleDurationMs）
//  - 服务端在每个 nextCastAt 结算一杆，客户端在其后调用 /api/fishing/sync（携带
//    X-Fishing-Run-Snapshot-Key）领取结算，settlement.mode === "online" 即在线渔获
//  - 次数耗尽 run 结束 -> 补杆（refill）-> 重新开始
//  - 凭证失效由 GameClient 内部自动续期/重登；此处只做节拍循环与异常退避
import { definePlugin } from "../core/plugin-host.js";
import { SESSION_STATUS } from "../core/session.js";
import { parseTime, sleepUntil, jitter, clamp } from "../util.js";

const BACKOFF_SEC = [5, 10, 20, 45, 60];

export default definePlugin({
  id: "keep-online",
  name: "保持在线",
  version: "1.0.0",
  description:
    "自动开始并持续维持在线钓鱼：按服务器节拍同步渔获，次数耗尽自动补杆，掉线自动重连/重登。这是实现「在线模式挂机」的核心插件。",
  defaultEnabled: false,
  defaultConfig: {
    autoRefill: true,
    autoTravel: false,
    syncJitterMs: 600,
    retrySec: 30,
  },
  configSchema: [
    {
      key: "autoRefill",
      type: "boolean",
      label: "次数耗尽自动补杆",
      hint: "钓鱼次数用完后自动补满并继续（可能消耗金币）",
      default: true,
    },
    {
      key: "autoTravel",
      type: "boolean",
      label: "开跑前跟随航线助手",
      hint: "每次重新开始钓鱼前调用游戏内「航线助手」切换地图",
      default: false,
    },
    {
      key: "syncJitterMs",
      type: "number",
      label: "同步抖动 (ms)",
      hint: "在服务器节拍基础上叠加随机延迟，模拟真人节奏",
      default: 600,
      min: 0,
      max: 3000,
      step: 100,
    },
    {
      key: "retrySec",
      type: "number",
      label: "异常重试间隔 (秒)",
      hint: "网络异常或服务端报错后的重试间隔",
      default: 30,
      min: 5,
      max: 300,
      step: 5,
    },
  ],

  async onStart(ctx) {
    const S = ctx.state;
    S.aborted = false;
    S.snapshotKey = "missing";
    S.keyRunId = null;
    S.backoffIdx = 0;
    ctx.session.setStatus(SESSION_STATUS.STARTING);
    ctx.log.info("保持在线", "引擎启动，开始维持在线钓鱼");

    const aborted = () => S.aborted || ctx.session.status === "stopped";

    const tick = async () => {
      const st = await ctx.api.fishingState();
      let run = st.run;

      // 1. 确保有一轮正在运行的钓鱼
      if (!run || run.status !== "running") {
        if (ctx.config.autoTravel) {
          try {
            const tv = await ctx.api.routeTravel();
            ctx.log.info("保持在线", `航线助手：${tv?.status ?? "?"} -> ${tv?.targetBiomeId ?? "-"}`);
          } catch (err) {
            ctx.log.warn("保持在线", `航线助手调用失败：${err?.message || err}`);
          }
        }
        try {
          run = (await ctx.api.fishingStart()).run;
          ctx.log.info("保持在线", `开始钓鱼：${run.remainingCasts}/${run.totalCasts} 杆，周期 ${run.cycleDurationMs}ms`);
        } catch (err) {
          if (!ctx.config.autoRefill) throw err;
          ctx.log.info("保持在线", `直接开始失败（${err?.message || err}），尝试补杆`);
          const rf = await ctx.api.fishingRefill();
          run = rf.run;
          if (!run || run.status !== "running") {
            run = (await ctx.api.fishingStart()).run;
          }
          ctx.log.info("保持在线", `补杆完成：${run?.remainingCasts ?? "?"} 杆可用`);
        }
      }

      if (!run || run.status !== "running") {
        throw new Error(`钓鱼未能开始（${run?.status ?? "unknown"}）`);
      }
      S.runId = run.id;
      ctx.session.reportRun(run);

      // 2. 等到下一次结算时间 + 抖动
      const cycle = run.cycleDurationMs || 6000;
      const nextCastAt = parseTime(run.nextCastAt) || Date.now() + cycle;
      const wakeAt = nextCastAt + jitter(clamp(ctx.config.syncJitterMs, 0, 3000));
      await sleepUntil(wakeAt, aborted, 800);
      if (aborted()) return;

      // 3. 同步渔获。run 换代时使用 "missing" 作为快照键（与官方客户端一致）
      const key = S.keyRunId === run.id ? S.snapshotKey : "missing";
      const resp = await ctx.api.fishingSync(key);
      if (resp?.run) {
        if (resp.run.snapshotKey) S.snapshotKey = resp.run.snapshotKey;
        S.keyRunId = resp.run.id;
        run = resp.run;
      }

      const settlement = resp?.settlement;
      ctx.session.reportSync({ run, settlement, playerPatch: resp?.playerPatch });
      ctx.session.setStatus(SESSION_STATUS.ONLINE);

      if (settlement?.mode && settlement.mode !== "online") {
        ctx.log.warn("保持在线", `本轮结算为「${settlement.mode}」模式，未按在线计（同步不及时？）`);
      }
      if (settlement?.castsResolved > 0) {
        ctx.log.info(
          "保持在线",
          `结算 ${settlement.castsResolved} 杆：金币 +${settlement.directGoldNet ?? 0}，经验 +${settlement.experience ?? 0}` +
            (settlement.fish?.length ? `，渔获 ${settlement.fish.reduce((a, f) => a + (f.quantity || 0), 0)} 条` : "")
        );
      }

      // 4. run 已结束（次数耗尽）-> 立即进入下一轮（下一 tick 会补杆重启）
      if (run && run.status !== "running") {
        ctx.log.info("保持在线", `本轮钓鱼结束（${run.status}），准备${ctx.config.autoRefill ? "补杆" : "重启"}`);
      }
    };

    const loop = async () => {
      while (!aborted()) {
        try {
          await tick();
          S.backoffIdx = 0;
        } catch (err) {
          if (aborted()) break;
          if (err?.code === "SESSION_EXPIRED" || err?.code === "NO_CREDENTIALS") {
            ctx.session.setStatus(SESSION_STATUS.EXPIRED, err?.message || "会话失效");
            ctx.log.error("保持在线", `会话已失效，引擎挂起：${err?.message || err}`);
            return;
          }
          const sec = clamp(BACKOFF_SEC[Math.min(S.backoffIdx, BACKOFF_SEC.length - 1)], 1, Number(ctx.config.retrySec) || 30);
          S.backoffIdx++;
          ctx.session.setStatus(SESSION_STATUS.RECONNECTING, err?.message || String(err));
          ctx.log.warn("保持在线", `异常：${err?.message || err}，${sec}s 后重试`);
          await sleepUntil(Date.now() + sec * 1000, aborted, 800);
        }
      }
      ctx.log.info("保持在线", "引擎已停止");
    };

    loop();
  },

  async onStop(ctx) {
    ctx.state.aborted = true;
  },
});
