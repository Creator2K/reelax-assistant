// 配置加载与持久化：data/config.json（密码/Cookie 属敏感数据，注意部署安全）
import fs from "node:fs";
import path from "node:path";
import { uid } from "./util.js";

const DEFAULTS = {
  port: Number(process.env.PORT) || 8580,
  host: process.env.HOST || "127.0.0.1",
  authToken: process.env.AUTH_TOKEN || "",
  baseUrl: process.env.REELAX_BASE_URL || "https://reelax.cn",
  sessions: [], // { id, label, authType, email, password, cookie, autoStart, plugins }
  pluginDefaults: {}, // { [pluginId]: { enabled, config } }
};

export class ConfigStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "config.json");
    this.data = { ...DEFAULTS };
    this.saveTimer = null;
    this.load();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.data = { ...DEFAULTS, ...parsed };
      // 环境变量优先
      if (process.env.PORT) this.data.port = Number(process.env.PORT);
      if (process.env.HOST) this.data.host = process.env.HOST;
      if (process.env.AUTH_TOKEN) this.data.authToken = process.env.AUTH_TOKEN;
      if (process.env.REELAX_BASE_URL) this.data.baseUrl = process.env.REELAX_BASE_URL;
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("[config] 读取失败，使用默认配置：", err.message);
      }
      this.saveNow();
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[config] 保存失败：", err.message);
    }
  }

  // ---------- 会话 ----------

  listSessions() {
    return this.data.sessions;
  }

  getSession(id) {
    return this.data.sessions.find((s) => s.id === id);
  }

  createSession(input) {
    const session = {
      id: uid(),
      label: input.label || input.email || "未命名账号",
      authType: input.authType === "cookie" ? "cookie" : "credentials",
      email: input.email || "",
      password: input.password || "",
      cookie: input.cookie || "",
      autoStart: input.autoStart !== false,
      plugins: {}, // { [pluginId]: { enabled, config } }
      createdAt: Date.now(),
    };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  updateSession(id, patch) {
    const s = this.getSession(id);
    if (!s) return null;
    const allowed = ["label", "email", "password", "cookie", "autoStart", "authType"];
    for (const k of allowed) {
      if (patch[k] !== undefined) s[k] = patch[k];
    }
    this.save();
    return s;
  }

  deleteSession(id) {
    const idx = this.data.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    this.data.sessions.splice(idx, 1);
    this.save();
    return true;
  }

  /** 会话级插件配置（不存在则返回 undefined） */
  getPluginState(sessionId, pluginId) {
    return this.getSession(sessionId)?.plugins?.[pluginId];
  }

  setPluginState(sessionId, pluginId, state) {
    const s = this.getSession(sessionId);
    if (!s) return null;
    s.plugins = s.plugins || {};
    s.plugins[pluginId] = { ...(s.plugins[pluginId] || {}), ...state };
    this.save();
    return s.plugins[pluginId];
  }

  // ---------- 插件全局默认 ----------

  getPluginDefault(pluginId) {
    return this.data.pluginDefaults[pluginId];
  }

  setPluginDefault(pluginId, { enabled, config } = {}) {
    const prev = this.data.pluginDefaults[pluginId] || {};
    this.data.pluginDefaults[pluginId] = {
      enabled: enabled ?? prev.enabled,
      config: { ...(prev.config || {}), ...(config || {}) },
    };
    this.save();
    return this.data.pluginDefaults[pluginId];
  }
}
