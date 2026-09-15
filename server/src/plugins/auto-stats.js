// 自动加点插件：升升级拿到属性点后按策略自动分配
//
// 协议（docs/PROTOCOL.md §4）：
//  - POST /api/player/stats/allocate { strength, intelligence, luck, endurance }（各维数量）
//  - POST /api/player/stats/reset 洗点：退回全部已投入点数（保留系统初始 100 耐力），消耗金币
//  - /api/me -> player.unspentStatPoints 待分配点数；player.stats.base 四维投入
//    （耐力的实际投入 = base.endurance - 100，系统白送 100 点不计入）
//
// 策略：
//  - priority  主属性优先：所有点灌入单一属性
//  - ratio     按比例：按权重分配本轮可投入的点
//  - target    补齐目标：把各维投入补到指定点数，不够按顺序填；溢出点默认留存
//    （若点数不够且已有点被投在超额属性上 → 需要「洗点搬运」，autoReset 开启时自动执行）
import { definePlugin } from "../core/plugin-host.js";

const STAT_KEYS = ["strength", "intelligence", "luck", "endurance"];
const STAT_LABELS = { strength: "力量", intelligence: "智力", luck: "运气", endurance: "耐力" };
const RESET_BASE_ENDURANCE = 100;

function parseRatio(s) {
  const parts = String(s || "")
    .split(/[:：,，]/)
    .map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0) || parts.every((n) => n === 0)) return null;
  return parts;
}

function parseTargets(s) {
  const parts = String(s || "")
    .split(/[:：,，]/)
    .map((x) => Math.max(0, Math.floor(Number(x.trim()) || 0)));
  if (parts.length !== 4) return null;
  return Object.fromEntries(STAT_KEYS.map((k, i) => [k, parts[i]]));
}

/** 投入点数（耐力扣除系统初始 100） */
function investedOf(statsBase) {
  const base = statsBase || {};
  return {
    strength: Math.max(0, base.strength || 0),
    intelligence: Math.max(0, base.intelligence || 0),
    luck: Math.max(0, base.luck || 0),
    endurance: Math.max(0, (base.endurance || 0) - RESET_BASE_ENDURANCE),
  };
}

function detail(body) {
  return STAT_KEYS.filter((k) => body[k] > 0)
    .map((k) => `${STAT_LABELS[k]}+${body[k]}`)
    .join("、") || "无";
}

export default definePlugin({
  id: "auto-stats",
  name: "自动加点",
  version: "1.0.0",
  description:
    "升级获得的属性点按策略自动分配：主属性优先 / 按比例 / 补齐目标投入。可选自动洗点搬运（消耗金币，默认关闭）。",
  defaultEnabled: false,
  defaultConfig: {
    mode: "priority",
    primary: "intelligence",
    ratio: "2:3:0:1",
    targets: "0:2000:0:100",
    autoReset: false,
    minPoints: 1,
  },
  configSchema: [
    {
      key: "mode",
      type: "select",
      label: "分配策略",
      default: "priority",
      options: [
        { value: "priority", label: "主属性优先（全部灌入）" },
        { value: "ratio", label: "按比例分配" },
        { value: "target", label: "补齐目标投入" },
      ],
    },
    {
      key: "primary",
      type: "select",
      label: "主属性（主属性优先模式）",
      default: "intelligence",
      options: STAT_KEYS.map((k) => ({ value: k, label: STAT_LABELS[k] })),
    },
    {
      key: "ratio",
      type: "string",
      label: "权重（按比例模式）",
      hint: "格式 力量:智力:运气:耐力，例如 2:3:0:1；全 0 视为无效",
      default: "2:3:0:1",
      placeholder: "2:3:0:1",
    },
    {
      key: "targets",
      type: "string",
      label: "目标投入（补齐目标模式）",
      hint: "各维目标投入点数（不含装备/鱼竿/图腾加成），格式同上，例如 0:2000:0:100",
      default: "0:2000:0:100",
      placeholder: "0:2000:0:100",
    },
    {
      key: "autoReset",
      type: "boolean",
      label: "需要时自动洗点搬运（消耗金币）",
      hint: "补齐目标模式下，点数不够且已有点投在超额属性上时，自动洗点后重新分配",
      default: false,
    },
    {
      key: "minPoints",
      type: "number",
      label: "攒够多少点才出手",
      hint: "避免每升 1 级就请求一次；策略不满足时点数会保留",
      default: 1,
      min: 1,
      max: 1000,
      step: 1,
    },
  ],

  async onStart(ctx) {
    ctx.state.allocating = false;
    ctx.state.timer = null;
    ctx.state.lastSkipLog = "";

    /** 防抖触发：升级点数可能跨多次同步到账，攒一攒再分配 */
    const schedule = (delayMs = 3000) => {
      if (ctx.state.timer) clearTimeout(ctx.state.timer);
      ctx.state.timer = ctx.schedule(delayMs, async () => {
        ctx.state.timer = null;
        try {
          await allocate();
        } catch (err) {
          ctx.log.error("自动加点", `分配流程异常：${err?.message || err}`);
        }
      });
    };

    const allocate = async () => {
      if (ctx.state.allocating) return;
      const me = await ctx.api.me();
      const player = me?.player;
      if (!player) return;
      let unspent = Math.max(0, Math.floor(player.unspentStatPoints || 0));
      const min = Math.max(1, Math.floor(Number(ctx.config.minPoints) || 1));
      if (unspent < min) return;

      const invested = investedOf(player.stats?.base);
      // 四个字段必须全部出现（可为 0），缺字段会被服务端拒绝
      const body = { strength: 0, intelligence: 0, luck: 0, endurance: 0 };
      let notes = [];

      if (ctx.config.mode === "priority") {
        const primary = STAT_KEYS.includes(ctx.config.primary) ? ctx.config.primary : "intelligence";
        body[primary] = unspent;
      } else if (ctx.config.mode === "ratio") {
        const weights = parseRatio(ctx.config.ratio);
        if (!weights) {
          ctx.log.warn("自动加点", `权重配置无效：「${ctx.config.ratio}」，本次跳过`);
          return;
        }
        const total = weights.reduce((a, b) => a + b, 0);
        let left = unspent;
        STAT_KEYS.forEach((k, i) => {
          const share = i === 3 ? left : Math.floor((unspent * weights[i]) / total);
          body[k] = share;
          left -= share;
        });
        if (left > 0) body.strength += left; // 舍入余数给力量（权重首位非零时语义最直观）
      } else if (ctx.config.mode === "target") {
        const targets = parseTargets(ctx.config.targets);
        if (!targets) {
          ctx.log.warn("自动加点", `目标配置无效：「${ctx.config.targets}」，本次跳过`);
          return;
        }
        const missing = STAT_KEYS.map((k) => Math.max(0, targets[k] - invested[k]));
        const missingTotal = missing.reduce((a, b) => a + b, 0);
        const surplus = STAT_KEYS.reduce((a, k) => a + Math.max(0, invested[k] - targets[k]), 0);

        if (unspent >= missingTotal) {
          // 点数充裕：按缺多少补多少
          STAT_KEYS.forEach((k, i) => (body[k] = missing[i]));
          const leftover = unspent - missingTotal;
          if (leftover > 0) notes.push(`溢出 ${leftover} 点留存（目标已满）`);
        } else {
          // 点数不够：判断是否需要洗点搬运
          const canRecover = surplus > 0 && unspent + surplus >= missingTotal;
          if (canRecover && ctx.config.autoReset) {
            ctx.log.info("自动加点", `点数不足（缺 ${missingTotal - unspent}），执行洗点搬运 ${surplus} 点`);
            await ctx.api.statsReset();
            const me2 = await ctx.api.me();
            unspent = Math.max(0, Math.floor(me2?.player?.unspentStatPoints || 0));
            const inv2 = investedOf(me2?.player?.stats?.base);
            STAT_KEYS.forEach((k, i) => (body[k] = Math.max(0, targets[k] - inv2[k])));
            notes.push("已洗点重配");
          } else if (canRecover && !ctx.config.autoReset) {
            skipOnce(ctx, `需搬运 ${surplus} 点才能补齐目标，未开启「自动洗点搬运」，点数保留`);
            return;
          } else {
            // 无法补齐：按 力量→智力→运气→耐力 顺序尽量填，不超额
            let pool = unspent;
            STAT_KEYS.forEach((k, i) => {
              const put = Math.min(pool, missing[i]);
              body[k] = put;
              pool -= put;
            });
            if (pool > 0) notes.push(`目标未达成（缺 ${missingTotal - unspent} 点），本次先投 ${unspent} 点`);
          }
        }
      } else {
        ctx.log.warn("自动加点", `未知策略：${ctx.config.mode}`);
        return;
      }

      const total = STAT_KEYS.reduce((a, k) => a + (body[k] || 0), 0);
      if (total <= 0) {
        skipOnce(ctx, "按当前策略没有可分配的点");
        return;
      }
      // target 模式可能只允许部分投放（其余留存），同样要过门槛
      if (total < min) {
        skipOnce(ctx, `可投放 ${total} 点低于门槛 ${min}，保留`);
        return;
      }

      ctx.state.allocating = true;
      try {
        const r = await ctx.api.statsAllocate(body);
        const p = r?.player;
        ctx.log.info(
          "自动加点",
          `✅ 分配 ${total} 点 → ${detail(body)}${notes.length ? "（" + notes.join("；") + "）" : ""}` +
            (p ? `，剩余待分配 ${p.unspentStatPoints ?? "?"}` : "")
        );
      } finally {
        ctx.state.allocating = false;
      }
    };

    // 升级点数随 fishing:sync 的 playerPatch 到账；再加 45s 兜底轮询
    ctx.on("fishing:sync", (evt) => {
      const unspent = evt?.playerPatch?.unspentStatPoints;
      if (Number(unspent) > 0) schedule(3000);
    });
    ctx.every(45_000, () => schedule(0));
  },
});

/** 同一原因只记一次，避免日志刷屏 */
function skipOnce(ctx, reason) {
  if (ctx.state.lastSkipLog === reason) return;
  ctx.state.lastSkipLog = reason;
  ctx.log.info("自动加点", reason);
}
