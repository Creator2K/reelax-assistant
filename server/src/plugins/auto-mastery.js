// 自动地图专精献祭：把背包里符合专精需求的鱼批量献给对应地图
//
// 协议：
//  - GET  /api/mastery
//      { biomes: [{ biomeId, biomeName, isUnlocked, masteryLevel,
//                   rarities: [{ rarity, isWaiting, fish: {id,name},
//                                remainingQuantity, availableQuantity }] }] }
//  - POST /api/mastery/{biomeId}/contribute-all { excludedRarities }
//      服务端按该地图当前需求自动匹配背包中的鱼
//
// 策略：能献就献——周期性（默认 12±3 分钟）遍历已解锁地图，只要存在可贡献的鱼
// 就提交（不限制稀有度）；每轮只处理一张地图，提交后复查进度，未推进则暂停，
// 避免重复消耗。
import { definePlugin } from "../core/plugin-host.js";
import { fishRarityLabel } from "./_lib.js";
import { sleep, jitter } from "../util.js";

export default definePlugin({
  id: "auto-mastery",
  name: "自动专精献祭",
  version: "1.1.0",
  description: "定期检查各地图专精需求，背包里能献的鱼直接全部献祭（服务端批量匹配）。每轮处理一张地图，自动核验进度。",
  defaultEnabled: false,
  defaultConfig: {
    intervalMin: 12,
  },
  configSchema: [
    {
      key: "intervalMin",
      type: "number",
      label: "检查间隔（分钟）",
      default: 12,
      min: 3,
      max: 120,
      step: 1,
    },
  ],

  async onStart(ctx) {
    ctx.state.running = false;
    ctx.state.lastIdleSig = "";

    const run = async (trigger) => {
      if (ctx.state.running) return;
      ctx.state.running = true;
      try {
        await check(ctx, trigger);
      } catch (err) {
        ctx.log.warn("专精献祭", `本轮失败：${err?.message || err}，稍后重试`);
      } finally {
        ctx.state.running = false;
      }
    };

    const intervalMs = Math.max(3, Number(ctx.config.intervalMin) || 12) * 60_000;
    ctx.every(intervalMs, () => {
      if (Math.random() < 0.25) return; // 随机跳过，形成自然抖动
      run("定时检查");
    });
    ctx.schedule(jitter(20_000), () => run("启动检查"));
    let lastSync = 0;
    ctx.on("fishing:sync", () => {
      const now = Date.now();
      if (now - lastSync < 5 * 60_000) return;
      lastSync = now;
      run("钓鱼同步");
    });
  },
});

async function check(ctx, trigger) {
  const overview = await ctx.api.mastery();
  const biomes = (overview?.biomes || []).filter((b) => b?.biomeId && b.isUnlocked !== false);

  // 专精进度越低越先献；只要该地图有任意可贡献项就入围
  const candidates = biomes
    .map((biome) => {
      const items = (biome.rarities || []).filter(
        (item) => !item.isWaiting && Math.min(item.remainingQuantity || 0, item.availableQuantity || 0) > 0
      );
      return { biome, items };
    })
    .filter((c) => c.items.length > 0)
    .sort((a, b) => (Number(a.biome.masteryLevel) || 0) - (Number(b.biome.masteryLevel) || 0));

  if (!candidates.length) {
    const sig = biomes.map((b) => `${b.biomeId}:${b.masteryLevel}`).join("|");
    if (ctx.state.lastIdleSig !== sig) {
      ctx.state.lastIdleSig = sig;
      ctx.log.info("专精献祭", `${trigger}：暂无可献祭的鱼（${biomes.length} 张地图已检查）`);
    }
    return;
  }

  // 每轮只处理一张地图
  const { biome, items } = candidates[0];
  const name = biome.biomeName || biome.biomeId;
  const detail = items
    .map((i) => `${i.fish?.name || i.rarity}×${Math.min(i.remainingQuantity || 0, i.availableQuantity || 0)}（${fishRarityLabel(i.rarity)}）`)
    .slice(0, 4)
    .join("、");
  const before = snapshot(biome);

  try {
    await ctx.api.masteryContributeAll(biome.biomeId, []);
    ctx.log.info("专精献祭", `${name}：已提交献祭（${detail}）`);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/频繁|RATE|TOO_MANY/i.test(msg)) {
      await sleep(4000 + Math.random() * 2000);
      try {
        await ctx.api.masteryContributeAll(biome.biomeId, []);
        ctx.log.info("专精献祭", `${name}：重试后提交成功（${detail}）`);
      } catch (err2) {
        ctx.log.warn("专精献祭", `${name}：重试仍失败（${err2?.message || err2}），本轮停止`);
        return;
      }
    } else {
      ctx.log.warn("专精献祭", `${name}：提交失败（${msg}），等待下轮`);
      return;
    }
  }

  // 复查进度，未推进则停止，避免重复消耗
  await sleep(1200);
  const after = await ctx.api.mastery();
  const biomeAfter = (after?.biomes || []).find((b) => b.biomeId === biome.biomeId);
  if (biomeAfter && !progressed(before, snapshot(biomeAfter))) {
    ctx.log.warn("专精献祭", `${name}：进度未变化，为避免重复消耗本轮停止`);
  }
}

function snapshot(biome) {
  return (biome.rarities || []).map((i) => ({
    rarity: i.rarity,
    completedLevel: i.completedLevel,
    contributed: i.contributedQuantity,
    remaining: i.remainingQuantity,
    fishId: i.fish?.id,
  }));
}

function progressed(before, after) {
  if (!after?.length) return false;
  return before.some((b) => {
    const a = after.find((x) => x.rarity === b.rarity);
    if (!a) return false;
    return (
      Number(a.completedLevel) > Number(b.completedLevel) ||
      Number(a.contributed) > Number(b.contributed) ||
      Number(a.remaining) < Number(b.remaining) ||
      (b.fishId && a.fishId && b.fishId !== a.fishId)
    );
  });
}
