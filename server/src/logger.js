// 环形缓冲日志：内存保留最近 N 条，支持订阅实时推送
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(limit = 3000) {
    this.limit = limit;
    this.buffer = [];
    this.subs = new Set();
  }

  push({ level = "info", sessionId = null, plugin = null, tag = "", msg }) {
    const entry = { t: Date.now(), level, sessionId, plugin, tag, msg: String(msg) };
    this.buffer.push(entry);
    if (this.buffer.length > this.limit) this.buffer.splice(0, this.buffer.length - this.limit);
    for (const sub of this.subs) {
      try {
        sub(entry);
      } catch {
        /* 订阅方异常不影响日志 */
      }
    }
    return entry;
  }

  debug(tag, msg, meta = {}) {
    return this.push({ level: "debug", tag, msg, ...meta });
  }
  info(tag, msg, meta = {}) {
    return this.push({ level: "info", tag, msg, ...meta });
  }
  warn(tag, msg, meta = {}) {
    return this.push({ level: "warn", tag, msg, ...meta });
  }
  error(tag, msg, meta = {}) {
    return this.push({ level: "error", tag, msg, ...meta });
  }

  /** 子日志：固定 sessionId / plugin */
  child({ sessionId = null, plugin = null } = {}) {
    const base = { sessionId, plugin };
    const self = this;
    return {
      debug: (tag, msg) => self.push({ level: "debug", tag, msg, ...base }),
      info: (tag, msg) => self.push({ level: "info", tag, msg, ...base }),
      warn: (tag, msg) => self.push({ level: "warn", tag, msg, ...base }),
      error: (tag, msg) => self.push({ level: "error", tag, msg, ...base }),
    };
  }

  subscribe(cb) {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  recent({ sessionId = null, minLevel = "debug", plugin = null, search = "", limit = 500 } = {}) {
    const min = LEVELS[minLevel] ?? 10;
    let out = this.buffer;
    if (sessionId) out = out.filter((e) => e.sessionId === sessionId);
    if (plugin) out = out.filter((e) => e.plugin === plugin);
    if (min > 10) out = out.filter((e) => (LEVELS[e.level] ?? 10) >= min);
    if (search) out = out.filter((e) => (e.tag + " " + e.msg).toLowerCase().includes(search.toLowerCase()));
    return out.slice(-limit);
  }
}
