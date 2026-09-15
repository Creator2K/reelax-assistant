// 插件共享工具库（`_` 开头的文件不会被当作插件加载）
import { sleep } from "../util.js";

/** 装备稀有度阶梯（低 -> 高） */
export const GEAR_RARITIES = ["common", "uncommon", "fine", "rare", "epic", "legendary", "mythic", "exotic", "arcane"];
export const GEAR_RARITY_LABELS = {
  common: "普通",
  uncommon: "罕见",
  fine: "精良",
  rare: "稀有",
  epic: "史诗",
  legendary: "传说",
  mythic: "神话",
  exotic: "奇异",
  arcane: "奥秘",
};

/** 鱼类稀有度阶梯（九级，低 -> 高） */
export const FISH_RARITIES = ["common", "uncommon", "fine", "rare", "epic", "legendary", "mythic", "exotic", "arcane"];
export const FISH_RARITY_LABELS = {
  common: "普通",
  uncommon: "罕见",
  fine: "精良",
  rare: "稀有",
  epic: "史诗",
  legendary: "传说",
  mythic: "神话",
  exotic: "奇异",
  arcane: "奥秘",
};

export function gearRarityRank(rarity) {
  const i = GEAR_RARITIES.indexOf(rarity);
  return i < 0 ? -1 : i;
}

export function fishRarityRank(rarity) {
  const i = FISH_RARITIES.indexOf(rarity);
  return i < 0 ? -1 : i;
}

export function fishRarityLabel(rarity) {
  return FISH_RARITY_LABELS[rarity] || rarity;
}

export const STAT_LABELS = { strength: "力量", intelligence: "智力", luck: "运气", endurance: "耐力" };

/** 解析 "a,b,c" / "a，b，c" 为小写集合 */
export function parseList(s) {
  return String(s || "")
    .split(/[,，、\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 分页拉取全部装备
 * 响应：{ gear: [{id,name,rarity,quality,slot,equippedSlot,isLocked,marketOrderId,...}], nextCursor, totalStats, ... }
 */
export async function fetchAllGear(api) {
  const out = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const page = await api.gearInventory(cursor);
    const gear = Array.isArray(page?.gear) ? page.gear : [];
    out.push(...gear);
    cursor = page?.nextCursor;
    if (!cursor) break;
    await sleep(300);
  }
  return out;
}

/**
 * 解析天气效果文本中的加成百分点："+20% 经验" -> 20，"无修正" -> 0
 * 返回 { xp, gold }（金色加成文本格式未知，仅识别经验与通用 %）
 */
export function parseWeatherBonus(effect) {
  const s = String(effect || "");
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return { xp: 0, gold: 0 };
  const v = Number(m[1]);
  return /经验|xp/i.test(s) ? { xp: v, gold: 0 } : { xp: v, gold: v };
}

/* ---------- 官方航线助手（/api/convenience）冲突检测 ---------- */

export const ASSISTANT_FEATURE_LABELS = {
  isAutoTravelEnabled: "自动换图",
  isAutoCheckInEnabled: "自动签到",
  isAutoBaitEnabled: "自动鱼饵",
  isAutoWorldBossRegistrationEnabled: "渊潮围猎自动报名",
  isAutoArcaneSacrificeEnabled: "奥秘献祭",
};

/**
 * 读取官方航线助手状态：
 *  { isEnabled, isOperational, settings: { isAutoTravelEnabled, ... } }
 * isOperational = 用户总开关打开 且 权益在有效期（航线助手目前免费但仍有权益到期概念）
 */
export async function getRouteAssistantState(api) {
  const d = await api.request("/api/convenience");
  const ra = d?.routeAssistant || {};
  return {
    isEnabled: ra.isEnabled === true,
    isOperational: ra.isOperational === true,
    settings: ra.settings || {},
    entitlementEndsAt: d?.entitlements?.["route-assistant"]?.endsAt || null,
  };
}

/**
 * 冲突检查：官方航线助手已生效且打开了指定功能时抛错（用于插件 onStart 拒绝启动）。
 * @param {object} api 签名客户端
 * @param {string} flag settings 里的功能键，如 isAutoTravelEnabled
 * @param {string} myName 插件名（用于报错文案）
 */
export async function assertNoAssistantConflict(api, flag, myName) {
  let state;
  try {
    state = await getRouteAssistantState(api);
  } catch (err) {
    // 状态读取失败不阻断（fail-open），运行时软检测会再次兜底
    const e = new Error(`（提示）无法读取官方航线助手状态：${err?.message || err}`);
    e.softWarning = true;
    throw e;
  }
  const feature = ASSISTANT_FEATURE_LABELS[flag] || flag;
  if (state.isOperational && state.settings?.[flag]) {
    throw new Error(
      `与官方航线助手冲突：助手已开启且启用了「${feature}」。请关闭航线助手或其「${feature}」开关后，再启用${myName}；两者同时工作会互相抢操作。`
    );
  }
  return state;
}

/** 运行时软检测用的同类错误判断 */
export function isSoftWarning(err) {
  return Boolean(err?.softWarning);
}
