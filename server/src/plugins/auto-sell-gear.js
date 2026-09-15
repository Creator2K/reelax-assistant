// 自动卖装备：两种可选策略
//
//  A. keep-best 保留同部位最优：按 部位 分组，品质高者留（品质相同比稀有度），
//     其余卖出。始终保护：已穿戴、已锁定、已上架市场的装备，以及不低于
//     「保护稀有度下限」的装备（防止把稀有 duplicate 无脑卖掉）。
//  B. below-quality 低于品质全卖：按「稀有度 + 品质上限」生成规则，交给服务端
//     sale-preview 匹配后卖出（与游戏内批量出售一致）。
//
// 协议：
//  - GET  /api/inventory/gear?cursor=  { gear: [{id,name,rarity,quality,slot,
//          equippedSlot,isLocked,marketOrderId,...}], nextCursor }
//  - POST /api/inventory/gear/sale-preview { rules: [{ rarity, maxQuality }] }
//          -> { gearIds, isTruncated, rarities? }
//  - POST /api/inventory/gear/sell { gearIds } -> { goldEarned, player, soldGearIds? }
import { definePlugin } from "../core/plugin-host.js";
import { fetchAllGear, gearRarityRank, GEAR_RARITIES, GEAR_RARITY_LABELS } from "./_lib.js";

export default definePlugin({
  id: "auto-sell-gear",
  name: "自动卖装备",
  version: "1.0.0",
  description:
    "自动出售背包装备。保留最优：同部位只留品质最好的（品质相同比稀有度），其余卖出；品质阈值：低于指定品质的直接卖。已穿戴/锁定/上架的装备始终保留。",
  defaultEnabled: false,
  defaultConfig: {
    mode: "keep-best",
    keepPerSlot: 1,
    protectRarity: "epic",
    thresholdRarity: "rare",
    thresholdQuality: 60,
    minIntervalMin: 5,
  },
  configSchema: [
    {
      key: "mode",
      type: "select",
      label: "出售策略",
      default: "keep-best",
      options: [
        { value: "keep-best", label: "保留同部位最优，其余卖出" },
        { value: "below-quality", label: "低于品质阈值全卖" },
      ],
    },
    {
      key: "keepPerSlot",
      type: "number",
      label: "每部位保留件数（保留最优模式）",
      default: 1,
      min: 1,
      max: 5,
      step: 1,
    },
    {
      key: "protectRarity",
      type: "select",
      label: "保护稀有度下限",
      hint: "两种模式下都不出售该稀有度及以上的装备",
      default: "epic",
      options: GEAR_RARITIES.map((r) => ({ value: r, label: GEAR_RARITY_LABELS[r] })),
    },
    {
      key: "thresholdRarity",
      type: "select",
      label: "该稀有度及以下才参与「品质阈值」判定",
      hint: "品质阈值模式下，高于该稀有度的装备不参与自动出售",
      default: "rare",
      options: GEAR_RARITIES.map((r) => ({ value: r, label: GEAR_RARITY_LABELS[r] })),
    },
    {
      key: "thresholdQuality",
      type: "number",
      label: "品质阈值（百分比）",
      hint: "品质 ≤ 该值的装备出售",
      default: 60,
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: "minIntervalMin",
      type: "number",
      label: "检查间隔（分钟）",
      default: 5,
      min: 1,
      max: 120,
      step: 1,
    },
  ],

  async onStart(ctx) {
    ctx.state.running = false;
    let lastRun = 0;

    const tryRun = (trigger, force = false) => {
      const now = Date.now();
      if (!force && now - lastRun < Math.max(1, Number(ctx.config.minIntervalMin) || 5) * 60_000) return;
      lastRun = now;
      if (ctx.state.running) return;
      ctx.state.running = true;
      run(ctx, trigger)
        .catch((err) => ctx.log.warn("卖装备", `本轮失败：${err?.message || err}`))
        .finally(() => (ctx.state.running = false));
    };

    // 钓到装备（settlement.gear）后延时检查 + 周期兜底
    ctx.on("fishing:sync", (evt) => {
      if ((evt?.settlement?.gear?.length || 0) > 0) ctx.schedule(15_000, () => tryRun("钓获装备"));
    });
    ctx.every(Math.max(1, Number(ctx.config.minIntervalMin) || 5) * 60_000, () => tryRun("定时检查"));
    ctx.schedule(20_000, () => tryRun("启动检查", true));
  },
});

async function run(ctx, trigger) {
  const protectRank = gearRarityRank(ctx.config.protectRarity);
  if (ctx.config.mode === "below-quality") {
    await runBelowQuality(ctx, protectRank, trigger);
  } else {
    await runKeepBest(ctx, protectRank, trigger);
  }
}

/** 模式 A：保留同部位最优 */
async function runKeepBest(ctx, protectRank, trigger) {
  const gear = await fetchAllGear(ctx.api);
  if (!gear.length) {
    idleLog(ctx, "背包中没有装备");
    return;
  }
  const keepN = Math.max(1, Math.floor(Number(ctx.config.keepPerSlot) || 1));

  // 分组：部位 -> 候选（排除保护项）
  const bySlot = new Map();
  const sold_candidates = [];
  for (const item of gear) {
    const isProtected =
      item.equippedSlot ||
      item.isLocked ||
      item.marketOrderId ||
      gearRarityRank(item.rarity) >= protectRank;
    if (isProtected) continue;
    const slot = item.slot || item.equippedSlot || "unknown";
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(item);
  }

  for (const [slot, items] of bySlot) {
    // 品质优先，品质相同比稀有度，再比 id 保证稳定
    items.sort(
      (a, b) =>
        (b.quality || 0) - (a.quality || 0) ||
        gearRarityRank(b.rarity) - gearRarityRank(a.rarity) ||
        String(a.id).localeCompare(String(b.id))
    );
    for (const item of items.slice(keepN)) sold_candidates.push(item);
  }

  if (!sold_candidates.length) {
    idleLog(ctx, `${trigger}：同部位均已保留最优，无可卖装备`);
    return;
  }

  const ids = sold_candidates.map((i) => i.id);
  const summary = sold_candidates
    .slice(0, 5)
    .map((i) => `${i.name}(${GEAR_RARITY_LABELS[i.rarity] || i.rarity}·Q${Math.round(i.quality || 0)})`)
    .join("、");
  const r = await ctx.api.gearSell(ids);
  const earned = r?.goldEarned ?? r?.player?.gold;
  ctx.log.info(
    "卖装备",
    `${trigger}：卖出 ${ids.length} 件（${summary}${ids.length > 5 ? " 等" : ""}），${earned != null ? `金币余额 ${Number(earned).toLocaleString("zh-CN")}` : "完成"}`
  );
}

/** 模式 B：低于品质阈值全卖（服务端规则匹配） */
async function runBelowQuality(ctx, protectRank, trigger) {
  const capRank = gearRarityRank(ctx.config.thresholdRarity);
  const q = Math.max(0, Math.min(100, Math.floor(Number(ctx.config.thresholdQuality) || 0)));
  const rules = [];
  for (const rarity of GEAR_RARITIES) {
    const rank = gearRarityRank(rarity);
    if (rank > capRank) break;
    if (rank >= protectRank) continue;
    rules.push({ rarity, maxQuality: q });
  }
  if (!rules.length) {
    idleLog(ctx, "品质阈值规则为空（稀有度范围或保护下限配置过严）");
    return;
  }
  const prev = await ctx.api.gearSalePreview(rules);
  const gearIds = prev?.gearIds || [];
  if (!gearIds.length) {
    idleLog(ctx, `${trigger}：没有符合阈值（≤${q}）的可卖装备`);
    return;
  }
  const r = await ctx.api.gearSell(gearIds);
  const earned = r?.goldEarned;
  ctx.log.info(
    "卖装备",
    `${trigger}：按阈值卖出 ${gearIds.length} 件${prev?.isTruncated ? "（本次达 100 件上限，稍后继续）" : ""}${earned != null ? `，获得 ${Number(earned).toLocaleString("zh-CN")} 金币` : ""}`
  );
}

function idleLog(ctx, msg) {
  if (ctx.state.lastIdle === msg) return;
  ctx.state.lastIdle = msg;
  ctx.log.info("卖装备", msg);
}
