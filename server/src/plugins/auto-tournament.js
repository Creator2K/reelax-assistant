// 自动报名赛事（个人赛 + 公会赛），可选自动进入比赛地图
//
// 协议：
//  - GET  /api/tournaments/overview        { current, upcoming: [...] }
//      个人赛条目：{ id, sequence, status, biomeId, startAt, endAt,
//                    canRegister, isRegistered, groups, ... }
//  - POST /api/tournaments/{id}/register
//  - GET  /api/guild-tournaments/overview  { current, upcoming }
//      公会赛条目：{ ..., entryStatus, canRegister, assignedBiomeId }（需要干部权限报名）
//  - PUT  /api/player/current-biome { biomeId }   （进入比赛地图，免费）
//
// 行为：每 2~3 分钟检查；canRegister 且未报名的个人赛直接报名；公会赛先查
// /api/guilds/me 的职位（officer 及以上）再报名。开赛前 leadSec 秒或比赛进行中，
// 自动前往比赛地图（assignedBiomeId 优先）。
import { definePlugin } from "../core/plugin-host.js";
import { getRouteAssistantState } from "./_lib.js";
import { sleep } from "../util.js";

export default definePlugin({
  id: "auto-tournament",
  name: "自动报名赛事",
  version: "1.0.0",
  description:
    "自动报名可参加的个人赛与公会赛（公会赛需干部权限），并在比赛开始前 / 进行中自动前往比赛地图参赛。",
  defaultEnabled: false,
  defaultConfig: {
    registerPersonal: true,
    registerGuild: false,
    travelToBiome: true,
    travelLeadSec: 180,
    checkEveryMin: 3,
  },
  configSchema: [
    { key: "registerPersonal", type: "boolean", label: "自动报名个人赛", default: true },
    {
      key: "registerGuild",
      type: "boolean",
      label: "自动报名公会赛（需干部）",
      hint: "只有公会干部（officer / co_leader / leader）能报名公会赛",
      default: false,
    },
    { key: "travelToBiome", type: "boolean", label: "自动前往比赛地图", default: true },
    {
      key: "travelLeadSec",
      type: "number",
      label: "开赛前多少秒进入地图",
      default: 180,
      min: 30,
      max: 1800,
      step: 30,
    },
    { key: "checkEveryMin", type: "number", label: "检查间隔（分钟）", default: 3, min: 1, max: 30, step: 1 },
  ],

  async onStart(ctx) {
    ctx.state.busy = false;
    ctx.state.registeredIds = new Set();
    ctx.state.lastIdle = "";

    // 报名功能与航线助手不冲突；但「自动前往比赛地图」与助手的「自动换图」冲突。
    // 助手开启换图时本插件不再自行进图（报名不受影响），travelTo 内还有运行时软检测。
    try {
      const st = await getRouteAssistantState(ctx.api);
      if (st.isOperational && st.settings?.isAutoTravelEnabled) {
        ctx.state.assistantTravelOn = true;
        ctx.log.warn(
          "赛事报名",
          "检测到官方航线助手已开启「自动换图」，本插件不再自行前往比赛地图（报名功能不受影响）；助手会负责把你带到比赛地图"
        );
      }
    } catch {
      /* 状态读取失败不阻断，travelTo 时还有软检测 */
    }

    const check = async (trigger) => {
      if (ctx.state.busy) return;
      ctx.state.busy = true;
      try {
        await checkPersonal(ctx, trigger);
        if (ctx.config.registerGuild) await checkGuild(ctx, trigger);
        else ctx.state.guildRole = undefined;
      } finally {
        ctx.state.busy = false;
      }
    };

    ctx.every(Math.max(1, Number(ctx.config.checkEveryMin) || 3) * 60_000, () => check("定时检查"));
    ctx.schedule(10_000, () => check("启动检查"));
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < 3 * 60_000) return;
      lastSync = now;
      check("钓鱼同步");
    });
  },
});

// ---------- 个人赛 ----------

async function checkPersonal(ctx, trigger) {
  const ov = await ctx.api.tournamentsOverview();
  const list = [ov?.current, ...(ov?.upcoming || [])].filter(Boolean);

  if (ctx.config.registerPersonal) {
    const cand = list.filter(
      (t) => t.canRegister && !t.isRegistered && (t.status === "scheduled" || t.status === "active") && !ctx.state.registeredIds.has(t.id)
    );
    for (const t of cand.sort((a, b) => new Date(a.startAt) - new Date(b.startAt))) {
      try {
        await ctx.api.tournamentRegister(t.id);
        ctx.state.registeredIds.add(t.id);
        ctx.log.info("赛事报名", `✅ 个人赛 #${t.sequence} 报名成功（${fmtRange(t)}）`);
        await sleep(800);
      } catch (err) {
        ctx.state.registeredIds.add(t.id); // 失败也标记，避免每轮重复请求同一了一场
        ctx.log.warn("赛事报名", `个人赛 #${t.sequence} 报名失败：${err?.message || err}`);
      }
    }
  }

  if (ctx.config.travelToBiome) {
    const current = ov?.current;
    if (current?.isRegistered) {
      await travelTo(ctx, current.assignedBiomeId || current.biomeId, `个人赛 #${current.sequence} 进行中`);
    } else {
      // 即将开赛：提前 leadSec 进入地图
      const soon = list.find(
        (t) => t.isRegistered && t.status === "scheduled" && t.startAt && Date.parse(t.startAt) - Date.now() <= (Number(ctx.config.travelLeadSec) || 180) * 1000
      );
      if (soon) {
        await travelTo(ctx, soon.assignedBiomeId || soon.biomeId, `个人赛 #${soon.sequence} 即将开赛`);
      } else {
        idle(ctx, "travel", `${trigger}：暂无需要进入的比赛地图`);
      }
    }
  }
}

// ---------- 公会赛 ----------

async function checkGuild(ctx, trigger) {
  let role = null;
  try {
    const g = await ctx.api.guildsMe();
    role = g?.membership?.role || null;
  } catch {
    role = null; // 未加入公会
  }
  if (!["officer", "co_leader", "leader"].includes(role)) {
    idle(ctx, "guild", ctx.state.guildRole === null ? "未加入公会，跳过公会赛" : "公会赛需要干部权限报名，跳过");
    ctx.state.guildRole = role === null ? null : "member";
    return;
  }
  ctx.state.guildRole = role;

  const ov = await ctx.api.guildTournamentsOverview();
  const list = [ov?.current, ...(ov?.upcoming || [])].filter(Boolean);
  const cand = list.filter((t) => t.canRegister && !t.entryStatus && (t.status === "scheduled" || t.status === "active"));
  for (const t of cand.sort((a, b) => new Date(a.startAt) - new Date(b.startAt))) {
    try {
      await ctx.api.request(`/api/guild-tournaments/${encodeURIComponent(t.id)}/register`, { method: "POST", idempotent: true });
      ctx.log.info("赛事报名", `✅ 公会赛 #${t.sequence} 报名成功（${fmtRange(t)}）`);
      await sleep(800);
    } catch (err) {
      ctx.log.warn("赛事报名", `公会赛 #${t.sequence} 报名失败：${err?.message || err}`);
    }
  }

  if (ctx.config.travelToBiome) {
    const current = ov?.current;
    if (current?.entryStatus) {
      await travelTo(ctx, current.assignedBiomeId || current.biomeId, `公会赛 #${current.sequence} 进行中`);
    }
  }
}

// ---------- 共用 ----------

async function travelTo(ctx, biomeId, reason) {
  if (!biomeId) return;
  // 软检测：航线助手接管换图时不抢操作
  try {
    const st = await getRouteAssistantState(ctx.api);
    if (st.isOperational && st.settings?.isAutoTravelEnabled) {
      if (!ctx.state.assistantTravelNoted) {
        ctx.state.assistantTravelNoted = true;
        ctx.log.warn("赛事报名", `官方航线助手已接管换图，跳过「${reason}」的进图操作`);
      }
      return;
    }
  } catch {}
  const key = `${biomeId}:${Math.floor(Date.now() / (10 * 60_000))}`; // 同一地图 10 分钟内只发一次
  if (ctx.state.lastTravel === key) return;
  ctx.state.lastTravel = key;
  try {
    const r = await ctx.api.biomeTravel(biomeId);
    const current = r?.player?.currentBiomeId;
    ctx.log.info("赛事报名", `⛵ ${reason}：已前往比赛地图 ${biomeId}${current && current !== biomeId ? `（当前 ${current}）` : ""}`);
  } catch (err) {
    ctx.log.warn("赛事报名", `${reason}：前往 ${biomeId} 失败——${err?.message || err}`);
  }
}

function fmtRange(t) {
  const s = t.startAt ? new Date(t.startAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
  return `${s} 开始`;
}

function idle(ctx, scope, msg) {
  const key = scope + ":" + msg;
  if (ctx.state["idle_" + scope] === msg) return;
  ctx.state["idle_" + scope] = msg;
  ctx.log.info("赛事报名", msg);
}
