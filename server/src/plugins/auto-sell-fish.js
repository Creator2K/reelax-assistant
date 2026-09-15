// 自动卖鱼：按稀有度分级处理背包渔获
//
//  - 稀有度 ≤「直接出售上限」-> POST /api/inventory/fish/sell 直接卖商店
//  - 稀有度 ≥「市场委托下限」-> POST /api/market/orders 挂限价卖单（参考价上浮）
//  - 中间档保留在背包不动
//
// 协议：
//  - GET  /api/inventory/fish
//      { fish: [{ fishId, name, rarity, quantity, sellPrice, totalSellValue,
//                 isLocked, isManuallyLocked, isMasteryLocked }] }
//  - POST /api/inventory/fish/sell { items: [{ fishId, quantity }] }
//  - GET  /api/market/config（市场需要已验证邮箱；未验证 403 EMAIL_VERIFICATION_REQUIRED）
  //  - GET  /api/market/reference-prices
  //      { fish: [ {groupType:"fish", fishId, referenceUnitPrice, sampleCount},
  //                {groupType:"biome-rarity", biomeId, rarity, referenceUnitPrice} ],
  //        gear: [ { rarity, qualityBand, normalizedReferenceUnitPrice, sampleCount } ],
  //        statistics: { windowDays, ... } }
  // 个别鱼种没有单鱼价条目，可用其 biome-rarity 组价兜底
//  - POST /api/market/orders { assetType: "fish", side: "sell", fishId,
//                              quantity, limitUnitPrice }
//
// 保护：始终跳过 锁定 / 手动锁定 / 专精锁定的鱼，以及专精当前需要的鱼种
// （对照 /api/mastery 需求，避免卖掉献祭要用的鱼）。
// 启动前置检查：市场接口需要「已验证邮箱」的账号，未验证时插件拒绝启动。
import { definePlugin } from "../core/plugin-host.js";
import { fishRarityRank, fishRarityLabel, FISH_RARITIES } from "./_lib.js";

export default definePlugin({
  id: "auto-sell-fish",
  name: "自动卖鱼",
  version: "1.2.0",
  description:
    "按稀有度分级处理背包渔获：低稀有度直接卖商店换金币，高稀有度挂鱼类市场限价委托（参考价上浮），中间档保留。自动跳过各类锁定与专精需求鱼种。需要已验证邮箱（市场权限）。",
  defaultEnabled: false,
  defaultConfig: {
    sellBelow: "uncommon",
    marketFrom: "rare",
    marketPremiumPct: 10,
    marketMaxOrders: 5,
    keepQty: 0,
    minIntervalMin: 10,
  },
  configSchema: [
    {
      key: "sellBelow",
      type: "select",
      label: "稀有度 ≤ 此档直接卖商店",
      default: "uncommon",
      options: FISH_RARITIES.map((r, i) => ({ value: r, label: `${i + 1}级·${fishRarityLabel(r)}` })),
    },
    {
      key: "marketFrom",
      type: "select",
      label: "稀有度 ≥ 此档挂市场委托",
      hint: "两档之间的鱼保留在背包",
      default: "rare",
      options: FISH_RARITIES.map((r, i) => ({ value: r, label: `${i + 1}级·${fishRarityLabel(r)}` })),
    },
    {
      key: "marketPremiumPct",
      type: "number",
      label: "委托加价（%）",
      hint: "挂单价 = 参考价 ×(1 + 加价%)，参考价不可用时跳过挂单",
      default: 10,
      min: -50,
      max: 300,
      step: 5,
    },
    {
      key: "marketMaxOrders",
      type: "number",
      label: "单轮最多挂单数",
      default: 5,
      min: 1,
      max: 20,
      step: 1,
    },
    {
      key: "keepQty",
      type: "number",
      label: "每种鱼保留数量",
      hint: "直卖时每种鱼至少保留这么多条（0 = 全卖）",
      default: 0,
      min: 0,
      max: 999,
      step: 1,
    },
    { key: "minIntervalMin", type: "number", label: "检查间隔（分钟）", default: 10, min: 2, max: 120, step: 1 },
  ],

  async onStart(ctx) {
    // 前置检查：市场权限 = 已验证邮箱。未验证直接拒绝启动（错误会显示在会话插件卡片上）
    try {
      await ctx.api.request("/api/market/config");
    } catch (err) {
      const msg = String(err?.message || err);
      if (err?.status === 403 || /验证|VERIF/i.test(msg)) {
        throw new Error(`市场权限未开通（需要已验证邮箱）：请先在游戏内完成邮箱验证，再启用自动卖鱼。直卖功能无法单独使用。`);
      }
      // 其他错误（网络等）不阻断启动，运行时会重试
      ctx.log.warn("卖鱼", `市场权限检查异常（${msg}），将继续启动并在挂单时重试`);
    }

    ctx.state.running = false;
    ctx.state.masteryProtect = new Map(); // fishId -> remaining（缓存 30 分钟）
    ctx.state.masteryAt = 0;
    let lastRun = 0;
    ctx.state.lastIdle = "";

    const tryRun = (trigger, force = false) => {
      const now = Date.now();
      if (!force && now - lastRun < Math.max(2, Number(ctx.config.minIntervalMin) || 10) * 60_000) return;
      lastRun = now;
      if (ctx.state.running) return;
      ctx.state.running = true;
      run(ctx, trigger)
        .catch((err) => ctx.log.warn("卖鱼", `本轮失败：${err?.message || err}`))
        .finally(() => (ctx.state.running = false));
    };

    ctx.on("fishing:sync", (evt) => {
      if ((evt?.settlement?.fish?.length || 0) > 0) ctx.schedule(30_000, () => tryRun("钓获渔获"));
    });
    ctx.every(Math.max(2, Number(ctx.config.minIntervalMin) || 10) * 60_000, () => tryRun("定时检查"));
    ctx.schedule(25_000, () => tryRun("启动检查", true));
  },
});

async function run(ctx, trigger) {
  const inv = await ctx.api.inventoryFish();
  const fish = Array.isArray(inv?.fish) ? inv.fish : [];
  if (!fish.length) {
    idle(ctx, "背包里没有鱼");
    return;
  }

  const sellRank = fishRarityRank(ctx.config.sellBelow);
  const marketRank = fishRarityRank(ctx.config.marketFrom);
  const keepQty = Math.max(0, Math.floor(Number(ctx.config.keepQty) || 0));
  if (sellRank < 0 || marketRank < 0) {
    ctx.log.warn("卖鱼", "稀有度档位配置无效");
    return;
  }

  // 专精保护（固定开启）：献祭需求里的鱼种不卖
  const masteryNeeds = await getMasteryNeeds(ctx);

  const sellable = [];
  const marketable = [];
  for (const f of fish) {
    if (!f || !f.fishId || !f.quantity) continue;
    if (f.isLocked || f.isManuallyLocked || f.isMasteryLocked) continue;
    const rank = fishRarityRank(f.rarity);
    if (rank < 0) continue;
    if (masteryNeeds?.has(f.fishId)) continue;
    if (rank <= sellRank) {
      const qty = Math.max(0, f.quantity - keepQty);
      if (qty > 0) sellable.push({ fishId: f.fishId, name: f.name, rarity: f.rarity, quantity: qty, sellPrice: f.sellPrice });
    } else if (rank >= marketRank) {
      marketable.push({ fishId: f.fishId, name: f.name, rarity: f.rarity, quantity: f.quantity });
    }
  }

  // 1. 直接卖商店
  if (sellable.length) {
    const items = sellable.map((s) => ({ fishId: s.fishId, quantity: s.quantity }));
    const r = await ctx.api.sellFish(items);
    const gold = r?.player?.gold;
    const earned = r?.goldEarned ?? r?.settlement?.gold;
    const value = sellable.reduce((a, s) => a + s.quantity * (s.sellPrice || 0), 0);
    ctx.log.info(
      "卖鱼",
      `${trigger}：直卖 ${sellable.length} 种鱼（${detail(sellable)}），约 ${value.toLocaleString("zh-CN")} 金币` +
        (earned != null ? `，实得 ${Number(earned).toLocaleString("zh-CN")}` : gold != null ? `，余额 ${Number(gold).toLocaleString("zh-CN")}` : "")
    );
  } else {
    idle(ctx, `${trigger}：没有可直卖的鱼`);
  }

  // 2. 挂市场委托
  if (marketable.length) {
    await listOnMarket(ctx, marketable);
  }
}

async function listOnMarket(ctx, marketable) {
  // 定价优先级：
  //  1) 市场在售卖单的近期行情（GET /api/market/orders?assetType=fish&side=sell&fishId=...&sort=price，
  //     与游戏内点开背包鱼看到的「市场委托」挂牌列表同源），按剩余量加权平均 —— 最贴近真实成交环境
  //  2) 官方参考价（GET /api/market/reference-prices，30 天窗口统计）：单鱼价，缺失时退回地图×稀有度组价
  let refPrices = null;
  try {
    refPrices = await ctx.api.request("/api/market/reference-prices");
  } catch (err) {
    marketNote(ctx, `读取参考价失败：${err?.message || err}`);
  }
  // 实测响应形如 { fish: [...], gear: [...], statistics: {...} }，fish 里混合两种条目：
  //  - { groupType: "fish", fishId, referenceUnitPrice, sampleCount }   单种鱼价
  //  - { groupType: "biome-rarity", biomeId, rarity, referenceUnitPrice } 地图×稀有度组价
  const fishArr = Array.isArray(refPrices?.fish)
    ? refPrices.fish
    : Array.isArray(refPrices?.prices)
      ? refPrices.prices
      : Array.isArray(refPrices?.items)
        ? refPrices.items
        : [];
  const byFish = new Map();
  const byGroup = new Map();
  for (const p of fishArr) {
    if (!p) continue;
    if (p.groupType === "biome-rarity" && p.biomeId && p.rarity) {
      byGroup.set(p.biomeId + "|" + p.rarity, Number(p.referenceUnitPrice) || 0);
    } else if (p.fishId || p.id) {
      byFish.set(p.fishId || p.id, Number(p.referenceUnitPrice ?? p.referencePrice ?? p.price ?? p.unitPrice) || 0);
    }
  }
  const refPriceOf = (f) => {
    const own = byFish.get(f.fishId);
    if (own > 0) return own;
    const group = byGroup.get(f.biomeId + "|" + f.rarity);
    return group > 0 ? group : null;
  };

  // 在售卖单 → 加权均价（顺序价不是严格排序，自己算）。上限拉 3 页防止超长尾部
  const marketAvgOf = async (fishId) => {
    const prices = []; // [price, remainingQuantity]
    let cursor = null;
    for (let i = 0; i < 3; i++) {
      const q = `/api/market/orders?assetType=fish&side=sell&fishId=${encodeURIComponent(fishId)}&sort=price` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      let d;
      try {
        d = await ctx.api.request(q);
      } catch (err) {
        if (!prices.length) return null; // 行情完全拿不到，交给参考价兜底
        break;
      }
      for (const o of d?.orders || []) {
        const qty = Math.max(0, Number(o?.remainingQuantity) || 0);
        const px = Number(o?.limitUnitPrice) || 0;
        if (qty > 0 && px > 0) prices.push([px, qty]);
      }
      cursor = d?.nextCursor;
      if (!cursor) break;
    }
    if (!prices.length) return null;
    const totalQty = prices.reduce((a, [, q]) => a + q, 0);
    if (totalQty <= 0) return null;
    return prices.reduce((a, [p, q]) => a + p * q, 0) / totalQty;
  };

  const maxOrders = Math.max(1, Math.floor(Number(ctx.config.marketMaxOrders) || 5));
  const premium = (Number(ctx.config.marketPremiumPct) || 0) / 100;
  let listed = 0;
  let noRef = 0;
  for (const f of marketable) {
    if (listed >= maxOrders) break;
    const live = await marketAvgOf(f.fishId);
    const ref = live != null ? live : refPriceOf(f);
    if (!ref || ref <= 0) {
      noRef++;
      if (noRef === 1) ctx.log.warn("卖鱼", `${f.name}（${fishRarityLabel(f.rarity)}）没有参考价，跳过挂单`);
      continue;
    }
    const unit = Math.max(1, Math.floor(ref * (1 + premium)));
    const src = live != null ? "近期均价" : "官方参考价";
    try {
      await ctx.api.request("/api/market/orders", {
        method: "POST",
        idempotent: true,
        body: { assetType: "fish", side: "sell", fishId: f.fishId, quantity: f.quantity, limitUnitPrice: unit },
      });
      listed++;
      ctx.log.info("卖鱼", `🏛 已挂委托：${f.name} ×${f.quantity} @ ${unit.toLocaleString("zh-CN")}/条（${fishRarityLabel(f.rarity)}，${src} ${Math.floor(ref).toLocaleString("zh-CN")}）`);
    } catch (err) {
      marketNote(ctx, `挂单失败（${f.name}）：${err?.message || err}`);
      return;
    }
  }
  if (noRef > 1) ctx.log.info("卖鱼", `另有 ${noRef - 1} 种鱼同样缺少参考价，已跳过`);
  if (!listed) ctx.log.info("卖鱼", "本轮没有挂出新的市场委托");
}

async function getMasteryNeeds(ctx) {
  const now = Date.now();
  if (now - ctx.state.masteryAt < 30 * 60_000 && ctx.state.masteryProtect.size) return ctx.state.masteryProtect;
  try {
    const ov = await ctx.api.mastery();
    const map = new Map();
    for (const biome of ov?.biomes || []) {
      for (const item of biome.rarities || []) {
        if (item?.fish?.id && (item.remainingQuantity || 0) > 0) {
          map.set(item.fish.id, item.remainingQuantity);
        }
      }
    }
    ctx.state.masteryProtect = map;
    ctx.state.masteryAt = now;
    return map;
  } catch (err) {
    ctx.log.warn("卖鱼", `读取专精需求失败（${err?.message || err}），本轮不做专精保护`);
    return null;
  }
}

function marketNote(ctx, msg) {
  if (ctx.state.marketNote === msg) return;
  ctx.state.marketNote = msg;
  ctx.log.warn("卖鱼", msg);
}

function detail(list) {
  return list
    .slice(0, 4)
    .map((s) => `${s.name}×${s.quantity}`)
    .join("、");
}

function idle(ctx, msg) {
  if (ctx.state.lastIdle === msg) return;
  ctx.state.lastIdle = msg;
  ctx.log.info("卖鱼", msg);
}
