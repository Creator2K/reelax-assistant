// 通用工具函数
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const jitter = (ms) => Math.round(ms * (0.5 + Math.random()));

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const uid = () => cryptoRandomId();

export function cryptoRandomId() {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newIdempotencyKey() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return cryptoRandomId() + cryptoRandomId();
}

export function maskSecret(s) {
  if (!s || typeof s !== "string") return s;
  if (s.length <= 8) return "****";
  return s.slice(0, 4) + "****" + s.slice(-4);
}

/** 等待到目标绝对时间戳（ms），每 tickMs 检查一次 shouldAbort，避免无法响应停止 */
export async function sleepUntil(targetMs, shouldAbort, tickMs = 500) {
  for (;;) {
    if (shouldAbort()) return false;
    const remain = targetMs - Date.now();
    if (remain <= 0) return true;
    await sleep(Math.min(remain, tickMs));
  }
}

/** 将 ISO 字符串或毫秒数解析为 ms 时间戳，失败返回 null */
export function parseTime(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
