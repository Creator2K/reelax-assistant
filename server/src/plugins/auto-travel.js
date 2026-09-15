// 自动切图：自研版「航海助手」（免费手动换图接口）
//
// 协议：
//  - GET /api/biomes
//      { biomes: [{ id, name, isUnlocked, isCurrent, valueMultiplier,
//                   weather: { weatherId, effect, ... }, activeCompetitions }] }
//  - PUT /api/player/current-biome { biomeId }   手动换图（免费）
//
// 三种优先模式（换图逻辑永远优先前往「当前策略下最优的已解锁地图」）：
//  - competition 比赛优先：有活跃比赛的已解锁地图 > 价值收益
//  - goldwind    金风优先：正在刮金风（gilded_current，直接金币大幅提高）的地图 > 价值收益
//  - experience  经验优先：经验收益最高（价值倍率 × 天气经验加成）
// 迟滞：收益需比当前地图高出门槛才切换；每次切换有冷却，防止来回横跳。
import { definePlugin } from "../core/plugin-host.js";
import { parseWeatherBonus, assertNoAssistantConflict, getRouteAssistantState, isSoftWarning } from "./_lib.js";

const GOLDWIND_WEATHER_ID = "gilded_current";

export default definePlugin({
  id: "auto-travel",
  name: "自动切图",
  version: "1.1.0",
  description:
    "自动前往最优的已解锁地图。三种优先模式：比赛优先、金风优先（直接金币大幅提高的特殊天气）、经验优先。使用免费的手动换图接口，无需购买航线助手。",
  defaultEnabled: false,
  defaultConfig: {
    mode: "experience",
    checkEverySec: 120,
    minImprovePct: 3,
    travelCooldownSec: 600,
  },
  configSchema: [
    {
      key: "mode",
      type: "select",
      label: "优先模式",
      default: "experience",
      options: [
        { value: "experience", label: "经验优先" },
        { value: "goldwind", label: "金风优先" },
        { value: "competition", label: "比赛优先" },
      ],
    },
    { key: "checkEverySec", type: "number", label: "检查间隔（秒）", default: 120, min: 60, max: 1800, step: 30 },
    {
      key: "minImprovePct",
      type: "number",
      label: "切换迟滞（%）",
      hint: "收益需比当前地图高出该百分比才切换，防止频繁横跳（比赛/金风命中时不适用）",
      default: 3,
      min: 0,
      max: 100,
      step: 1,
    },
    { key: "travelCooldownSec", type: "number", label: "换图冷却（秒）", default: 600, min: 120, max: 3600, step: 60 },
  ],

  async onStart(ctx) {
    // 与官方航线助手冲突检测：助手开启且启用了「自动换图」时拒绝启动
    try {
      await assertNoAssistantConflict(ctx.api, "isAutoTravelEnabled", "自动切图");
    } catch (err) {
      if (!isSoftWarning(err)) throw err;
      ctx.log.warn("自动切图", err.message);
    }

    ctx.state.busy = false;
    ctx.state.lastTravelAt = 0;
    ctx.state.lastIdle = "";
    ctx.state.conflicted = false;

    const check = async (trigger) => {
      if (ctx.state.busy || ctx.state.conflicted) return;
      const now = Date.now();
      if (now - ctx.state.lastTravelAt < (Number(ctx.config.travelCooldownSec) || 600) * 1000) return;
      ctx.state.busy = true;
      try {
        await decide(ctx, trigger);
      } catch (err) {
        ctx.log.warn("自动切图", `${trigger}：${err?.message || err}`);
      } finally {
        ctx.state.busy = false;
      }
    };

    ctx.every(Math.max(60, Number(ctx.config.checkEverySec) || 120) * 1000, () => check("定时检查"));
    // 整点天气刷新后尽快跟进（钓鱼同步作为节拍器，节流 60s）
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < 60_000) return;
      lastSync = now;
      check("钓鱼同步");
    });
    ctx.schedule(15_000, () => check("启动检查"));

    // 运行时软检测：官方航线助手中途开启「自动换图」时自动停手
    ctx.every(8 * 60_000, async () => {
      try {
        const st = await getRouteAssistantState(ctx.api);
        if (st.isOperational && st.settings?.isAutoTravelEnabled && !ctx.state.conflicted) {
          ctx.state.conflicted = true;
          ctx.log.warn("自动切图", "检测到官方航线助手已开启「自动换图」，本插件暂停工作，避免互相抢图");
        }
      } catch {}
    });
  },
});

async function decide(ctx, trigger) {
  const data = await ctx.api.biomes();
  const biomes = (data?.biomes || []).filter(Boolean);
  const current = biomes.find((b) => b.isCurrent);
  const unlocked = biomes.filter((b) => b.isUnlocked);
  if (!current || !unlocked.length) {
    idle(ctx, "地图数据尚未就绪");
    return;
  }

  const valueScore = (b) => b.valueMultiplier || 1;
  const xpScore = (b) => (b.valueMultiplier || 1) * (1 + parseWeatherBonus(b.weather?.effect).xp / 100);

  // 1. 比赛优先模式：活跃比赛的地图最优先
  if (ctx.config.mode === "competition") {
    const compBiome = unlocked.find((b) => (b.activeCompetitions || []).length > 0);
    if (compBiome && compBiome.id !== current.id) {
      await doTravel(ctx, compBiome, "比赛进行中");
      return;
    }
  }

  // 2. 金风优先模式：正在刮金风的地图最优先
  if (ctx.config.mode === "goldwind") {
    const goldwind = unlocked.find((b) => b.weather?.weatherId === GOLDWIND_WEATHER_ID);
    if (goldwind && goldwind.id !== current.id) {
      await doTravel(ctx, goldwind, "金风天气（直接金币大幅提高）");
      return;
    }
  }

  // 3. 兜底：按经验收益挑最优（迟滞生效）
  let best = null;
  for (const b of unlocked) {
    if (b.id === current.id) continue;
    if (!best || xpScore(b) > xpScore(best)) best = b;
  }
  if (!best) {
    idle(ctx, `${trigger}：没有其他已解锁地图`);
    return;
  }

  const improve = xpScore(best) / xpScore(current) - 1;
  if (improve * 100 < (Number(ctx.config.minImprovePct) || 3)) {
    idle(ctx, `${trigger}：当前 ${current.name} 已是较优选择（${best.name} 仅高 ${(improve * 100).toFixed(1)}%，未达迟滞门槛）`);
    return;
  }

  const reason =
    ctx.config.mode === "competition" ? "无活跃比赛，按经验收益" : ctx.config.mode === "goldwind" ? "暂无金风天气，按经验收益" : "经验更优";
  await doTravel(ctx, best, `${reason}：+${(improve * 100).toFixed(1)}%`);
}

async function doTravel(ctx, biome, reason) {
  ctx.state.lastTravelAt = Date.now();
  try {
    const r = await ctx.api.biomeTravel(biome.id);
    const cur = r?.player?.currentBiomeId;
    if (cur && cur !== biome.id) {
      ctx.log.warn("自动切图", `前往 ${biome.name} 未生效（当前 ${cur}），稍后重试`);
      return;
    }
    ctx.log.info(
      "自动切图",
      `⛵ ${reason} -> ${biome.name}（倍率 ×${biome.valueMultiplier ?? 1}${biome.weather?.name ? `，天气：${biome.weather.name}` : ""}）`
    );
  } catch (err) {
    ctx.log.warn("自动切图", `前往 ${biome.name} 失败：${err?.message || err}`);
  }
}

function idle(ctx, msg) {
  if (ctx.state.lastIdle === msg) return;
  ctx.state.lastIdle = msg;
  ctx.log.info("自动切图", msg);
}
