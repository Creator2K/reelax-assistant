// 渊潮围猎（世界 Boss）自动报名
//
// 协议：
//  - GET  /api/events/world-boss
//      { session: null | { boss: { weaknessStat, defenseStat, ... },
//                          player: { selectedStat, ... }, status, ... },
//        nextPrepareAt }
//  - POST /api/events/world-boss/selection { stat } -> { overview }
//    stat ∈ strength | intelligence | luck | endurance
//
// 出战属性策略：
//  - weakness 弱点：Boss 弱点属性（伤害 ×2）
//  - max      最大属性：按 面板属性 × 倍率（弱点×2、防守×0.5、普通×1）估算伤害取最大——
//             弱点双倍还不如某个单倍属性大时，自动上大的那个
//  - 固定四维之一
import { definePlugin } from "../core/plugin-host.js";
import { STAT_LABELS, assertNoAssistantConflict, getRouteAssistantState, isSoftWarning } from "./_lib.js";

const STAT_KEYS = ["strength", "intelligence", "luck", "endurance"];

function damageMultiplier(stat, boss) {
  if (stat === boss?.weaknessStat) return 2;
  if (stat === boss?.defenseStat) return 0.5;
  return 1;
}
export default definePlugin({
  id: "auto-world-boss",
  name: "渊潮围猎报名",
  version: "1.1.0",
  description:
    "渊潮围猎（世界 Boss）开场后自动报名。出战属性可选：Boss 弱点（×2）、按预计伤害自动选最大属性（弱点双倍不如单倍大属性时上大属性），或固定某项。",
  defaultEnabled: false,
  defaultConfig: {
    stat: "weakness",
    checkEverySec: 90,
  },
  configSchema: [
    {
      key: "stat",
      type: "select",
      label: "出战属性",
      default: "weakness",
      options: [
        { value: "weakness", label: "Boss 弱点（×2 伤害）" },
        { value: "max", label: "最大属性（按预计伤害自动选）" },
        { value: "strength", label: "固定：力量" },
        { value: "intelligence", label: "固定：智力" },
        { value: "luck", label: "固定：运气" },
        { value: "endurance", label: "固定：耐力" },
      ],
    },
    {
      key: "checkEverySec",
      type: "number",
      label: "检查间隔（秒）",
      default: 90,
      min: 30,
      max: 600,
      step: 10,
    },
  ],

  async onStart(ctx) {
    // 与官方航线助手冲突检测：助手开启且启用了「围猎自动报名」时拒绝启动
    try {
      await assertNoAssistantConflict(ctx.api, "isAutoWorldBossRegistrationEnabled", "渊潮围猎报名");
    } catch (err) {
      if (!isSoftWarning(err)) throw err;
      ctx.log.warn("渊潮围猎", err.message);
    }

    ctx.state.busy = false;
    ctx.state.lastSessionKey = null;
    ctx.state.conflicted = false;

    const check = async (trigger) => {
      if (ctx.state.busy || ctx.state.conflicted) return;
      ctx.state.busy = true;
      try {
        await checkBoss(ctx, trigger);
      } catch (err) {
        const msg = String(err?.message || err);
        // 报名窗口未开 / 场次刚结束等业务错误，降级为一次性提示
        if (ctx.state.lastErr !== msg) {
          ctx.state.lastErr = msg;
          ctx.log.warn("渊潮围猎", `${trigger}：${msg}`);
        }
      } finally {
        ctx.state.busy = false;
      }
    };

    ctx.every(Math.max(30, Number(ctx.config.checkEverySec) || 90) * 1000, () => check("定时检查"));
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < 60_000) return;
      lastSync = now;
      check("钓鱼同步");
    });
    ctx.schedule(8_000, () => check("启动检查"));

    // 运行时软检测：官方航线助手中途开启「围猎自动报名」时自动停手
    ctx.every(8 * 60_000, async () => {
      try {
        const st = await getRouteAssistantState(ctx.api);
        if (st.isOperational && st.settings?.isAutoWorldBossRegistrationEnabled && !ctx.state.conflicted) {
          ctx.state.conflicted = true;
          ctx.log.warn("渊潮围猎", "检测到官方航线助手已开启「渊潮围猎自动报名」，本插件暂停报名，避免重复操作");
        }
      } catch {}
    });
  },
});

async function pickStat(ctx, session) {
  const boss = session?.boss || {};
  const mode = ctx.config.stat;

  if (mode === "weakness") {
    if (!boss.weaknessStat) return null;
    return { stat: boss.weaknessStat, note: "Boss 弱点（×2）" };
  }

  if (mode === "max") {
    let panel = null;
    try {
      const me = await ctx.api.me();
      panel = me?.player?.stats?.total || null;
    } catch (err) {
      ctx.log.warn("渊潮围猎", `读取属性面板失败：${err?.message || err}`);
      return null;
    }
    if (!panel) return null;
    const ranked = STAT_KEYS.map((stat) => {
      const value = Math.max(0, Number(panel[stat]) || 0);
      const mult = damageMultiplier(stat, boss);
      const relation = stat === boss.weaknessStat ? 2 : stat === boss.defenseStat ? 0 : 1;
      return { stat, damage: value * mult, mult, relation };
    }).sort((a, b) => b.damage - a.damage || b.relation - a.relation);
    const best = ranked[0];
    const note =
      best.stat === boss.weaknessStat
        ? "最大属性恰为弱点（×2）"
        : `${STAT_LABELS[best.stat]}×${best.mult} 的预计伤害已超过弱点${STAT_LABELS[boss.weaknessStat] || "?"}×2`;
    return { stat: best.stat, note };
  }

  if (STAT_KEYS.includes(mode)) return { stat: mode, note: "按配置固定" };
  return null;
}

async function checkBoss(ctx, trigger) {
  const overview = await ctx.api.worldBoss();
  const session = overview?.session;
  if (!session) {
    if (ctx.state.lastSessionKey !== "none") {
      ctx.state.lastSessionKey = "none";
      const next = overview?.nextPrepareAt ? new Date(overview.nextPrepareAt).toLocaleString("zh-CN") : "?";
      ctx.log.info("渊潮围猎", `${trigger}：暂无场次，下一场准备时间 ${next}`);
    }
    return;
  }
  const key = session.id || session.boss?.id || session.startedAt || "current";
  const selected = session.player?.selectedStat;
  if (selected) {
    if (ctx.state.lastSessionKey !== key) {
      ctx.state.lastSessionKey = key;
      ctx.log.info("渊潮围猎", `本场已报名（出战 ${STAT_LABELS[selected] || selected}），弱点 ${(STAT_LABELS[session.boss?.weaknessStat] || session.boss?.weaknessStat) || "未知"}`);
    }
    return;
  }

  const choice = await pickStat(ctx, session);
  if (!choice) {
    ctx.log.warn("渊潮围猎", "无法确定出战属性（无弱点且面板不可用），跳过报名");
    return;
  }
  const r = await ctx.api.worldBossSelect(choice.stat);
  ctx.state.lastSessionKey = key;
  ctx.log.info(
    "渊潮围猎",
    `✅ 已报名出战 ${STAT_LABELS[choice.stat]}（${choice.note}；Boss 弱点：${STAT_LABELS[session.boss?.weaknessStat] || "?"}，防守：${STAT_LABELS[session.boss?.defenseStat] || "?"}）`
  );
  if (r?.overview) {
    const sel = r.overview?.session?.player?.selectedStat;
    if (sel && sel !== choice.stat) ctx.log.warn("渊潮围猎", `报名后服务端出战属性为 ${STAT_LABELS[sel] || sel}，与请求不一致`);
  }
}
