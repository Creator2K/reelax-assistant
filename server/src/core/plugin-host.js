// 插件宿主：注册、按会话实例化、钩子分发（错误隔离）、受管定时器
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
/**
 * 插件定义示例：
 * export default definePlugin({
 *   id: "my-plugin",
 *   name: "我的插件",
 *   description: "……",
 *   defaultConfig: { foo: 1 },
 *   configSchema: [{ key: "foo", type: "number", label: "Foo", default: 1 }],
 *   async onStart(ctx) {},
 *   async onStop(ctx) {},
 *   async onTick(ctx) {},            // 每 60s
 *   async onFishingSync(ctx, evt) {} // 每次钓鱼同步
 * });
 */
export function definePlugin(def) {
  if (!def.id) throw new Error("插件缺少 id");
  return def;
}

export class PluginHost {
  constructor({ config, logger, bus, externalDir }) {
    this.config = config;
    this.log = logger;
    this.bus = bus;
    this.externalDir = externalDir;
    this.registry = new Map(); // pluginId -> definition
    this.instances = new Map(); // sessionId -> Map(pluginId -> { plugin, ctx, timers })
    this.startErrors = new Map(); // sessionId -> Map(pluginId -> errorMessage)
  }

  register(plugin) {
    if (this.registry.has(plugin.id)) {
      this.log.warn("插件", `插件 ${plugin.id} 重复注册，已忽略`);
      return false;
    }
    this.registry.set(plugin.id, plugin);
    this.log.info("插件", `已注册插件：${plugin.name}（${plugin.id}）${plugin.builtin === false ? "［外部］" : ""}`);
    return true;
  }

  /** 从 server/src/plugins 与 data/plugins 加载插件 */
  async loadAll({ builtinDir, externalDir }) {
    const loadDir = async (dir, builtin) => {
      if (!dir || !fs.existsSync(dir)) return;
      let files = [];
      try {
        // `_` 开头的是共享库，不是插件
        files = fs.readdirSync(dir).filter((f) => !f.startsWith("_") && (f.endsWith(".js") || f.endsWith(".mjs")));
      } catch {
        return;
      }
      for (const f of files) {
        const file = path.join(dir, f);
        try {
          const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
          const plugin = mod.default;
          if (!plugin?.id) {
            this.log.warn("插件", `${f} 未导出 default 插件定义，已跳过`);
            continue;
          }
          plugin.builtin = builtin;
          plugin.sourceFile = file;
          this.register(plugin);
        } catch (err) {
          this.log.error("插件", `加载 ${f} 失败：${err?.message || err}`);
        }
      }
    };
    await loadDir(builtinDir, true);
    await loadDir(externalDir, false);
  }

  list() {
    return [...this.registry.values()].map((p) => {
      // 合并已存储的全局默认（否则插件中心开关刷新后会弹回注册表默认值）
      const stored = this.config.getPluginDefault(p.id);
      return {
        id: p.id,
        name: p.name,
        description: p.description || "",
        version: p.version || "0.0.0",
        builtin: p.builtin !== false,
        defaultEnabled: stored?.enabled ?? p.defaultEnabled !== false,
        defaultConfig: { ...(p.defaultConfig || {}), ...(stored?.config || {}) },
        configSchema: p.configSchema || [],
      };
    });
  }

  /** 会话启动：实例化全部启用的插件 */
  async startSession(session) {
    if (this.instances.has(session.id)) return;
    const map = new Map();
    this.instances.set(session.id, map);
    for (const plugin of this.registry.values()) {
      try {
        await this.startPlugin(session, plugin, map);
        this.clearStartError(session.id, plugin.id);
      } catch (err) {
        this.setStartError(session.id, plugin.id, err?.message || String(err));
        this.log.error("插件", `启动 ${plugin.id} 失败：${err?.message || err}`, { sessionId: session.id });
      }
    }
  }

  async startPlugin(session, plugin, map) {
    const state = this.resolvePluginState(session, plugin);
    if (!state.enabled) return;
    const config = { ...(plugin.defaultConfig || {}), ...(state.config || {}) };
    const timers = new Set();
    const unsubscribes = [];
    const log = this.log.child({ sessionId: session.id, plugin: plugin.id });

    const ctx = {
      pluginId: plugin.id,
      session,
      /** 签名游戏客户端：直接调用任意游戏 API */
      api: session.client,
      config,
      state: {},
      log,
      on: (event, handler) => {
        const off = this.bus.on(event, (payload) => {
          if (payload?.sessionId && payload.sessionId !== session.id) return;
          Promise.resolve()
            .then(() => handler(payload))
            .catch((err) => log.error(plugin.name, `事件 ${event} 处理失败：${err?.message || err}`));
        });
        unsubscribes.push(off);
        return off;
      },
      /** 受管定时器：会话停止时自动清理 */
      every: (ms, fn) => {
        const t = setInterval(() => {
          Promise.resolve()
            .then(() => fn())
            .catch((err) => log.error(plugin.name, `定时任务失败：${err?.message || err}`));
        }, ms);
        timers.add(t);
        return t;
      },
      schedule: (ms, fn) => {
        const t = setTimeout(() => {
          timers.delete(t);
          Promise.resolve()
            .then(() => fn())
            .catch((err) => log.error(plugin.name, `延时任务失败：${err?.message || err}`));
        }, ms);
        timers.add(t);
        return t;
      },
    };

    const inst = { plugin, ctx, timers, unsubscribes };
    // onStart 成功才注册实例（失败则插件不处于运行态，错误由调用方记录）
    try {
      if (plugin.onStart) await plugin.onStart(ctx);
    } catch (err) {
      for (const t of timers) {
        clearInterval(t);
        clearTimeout(t);
      }
      for (const off of unsubscribes) off();
      throw err;
    }
    map.set(plugin.id, inst);
    log.info("插件", `${plugin.name} 已启动`);
  }

  async stopSession(session) {
    const map = this.instances.get(session.id);
    if (!map) return;
    for (const [id, inst] of map) {
      try {
        if (inst.plugin.onStop) await inst.plugin.onStop(inst.ctx);
      } catch (err) {
        this.log.error("插件", `停止 ${id} 失败：${err?.message || err}`, { sessionId: session.id });
      }
      for (const t of inst.timers) {
        clearInterval(t);
        clearTimeout(t);
      }
      for (const off of inst.unsubscribes) off();
    }
    map.clear();
    this.instances.delete(session.id);
  }

  /** 单插件热启停（配置变更时调用）。返回 { ok, error } 便于接口层反馈启动失败原因 */
  async restartPlugin(session, pluginId) {
    const map = this.instances.get(session.id);
    const plugin = this.registry.get(pluginId);
    if (!plugin) return { ok: false, error: "插件未注册" };
    if (map?.has(pluginId)) {
      const inst = map.get(pluginId);
      try {
        if (inst.plugin.onStop) await inst.plugin.onStop(inst.ctx);
      } catch {
        /* 忽略停止错误 */
      }
      for (const t of inst.timers) {
        clearInterval(t);
        clearTimeout(t);
      }
      for (const off of inst.unsubscribes) off();
      map.delete(pluginId);
    }
    if (!map) {
      // 会话未运行：只更新配置，不实例化
      this.clearStartError(session.id, pluginId);
      return { ok: true };
    }
    try {
      const state = this.resolvePluginState(session, plugin);
      if (!state.enabled) {
        this.clearStartError(session.id, pluginId);
        return { ok: true, disabled: true };
      }
      await this.startPlugin(session, plugin, map);
      this.clearStartError(session.id, pluginId);
      return { ok: true };
    } catch (err) {
      const msg = err?.message || String(err);
      this.setStartError(session.id, pluginId, msg);
      this.log.error("插件", `启动 ${pluginId} 失败：${msg}`, { sessionId: session.id });
      return { ok: false, error: msg };
    }
  }

  // ---------- 导入 / 卸载（外部插件） ----------

  /**
   * 从代码文本导入外部插件：语法与结构校验后写入 externalDir 并热注册。
   * 返回插件摘要；失败抛错（文件不落盘）。
   */
  async importFromCode({ code, filename }) {
    if (!code || !code.trim()) throw new Error("插件代码为空");
    const safeName = (filename || `imported-${Date.now()}.js`).replace(/[^\w.-]+/g, "-");
    if (!/\.(js|mjs)$/.test(safeName)) throw new Error("文件名必须以 .js 或 .mjs 结尾");
    if (!fs.existsSync(this.externalDir)) fs.mkdirSync(this.externalDir, { recursive: true });

    const file = path.join(this.externalDir, safeName);
    if (fs.existsSync(file)) throw new Error(`同名文件已存在：${safeName}`);
    fs.writeFileSync(file, code, "utf8");

    try {
      const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
      const plugin = mod.default;
      if (!plugin?.id || !plugin?.name) throw new Error("必须 export default { id, name, ... } 插件定义");
      const existing = this.registry.get(plugin.id);
      if (existing) throw new Error(`插件 ID「${plugin.id}」已被占用（${existing.name}）`);
      plugin.builtin = false;
      plugin.sourceFile = file;
      this.register(plugin);
      return this.list().find((p) => p.id === plugin.id);
    } catch (err) {
      try {
        fs.unlinkSync(file);
      } catch {}
      throw err;
    }
  }

  /** 卸载外部插件：停止所有会话中的实例、移出注册表、删除文件 */
  async unload(pluginId) {
    const plugin = this.registry.get(pluginId);
    if (!plugin) throw new Error("插件未注册");
    if (plugin.builtin !== false) throw new Error("内置插件不支持卸载");
    for (const sessionId of [...this.instances.keys()]) {
      await this.stopOne(sessionId, pluginId);
    }
    this.registry.delete(pluginId);
    if (this.config.data.pluginDefaults?.[pluginId]) {
      delete this.config.data.pluginDefaults[pluginId];
      this.config.save();
    }
    if (plugin.sourceFile && this.externalDir && plugin.sourceFile.startsWith(this.externalDir)) {
      try {
        fs.unlinkSync(plugin.sourceFile);
      } catch {}
    }
    this.log.warn("插件", `已卸载插件：${plugin.name}（${pluginId}）`);
    return true;
  }

  /** 停掉某个会话中的单个插件实例（不做配置变更） */
  async stopOne(sessionId, pluginId) {
    const map = this.instances.get(sessionId);
    const inst = map?.get(pluginId);
    if (!inst) return;
    try {
      if (inst.plugin.onStop) await inst.plugin.onStop(inst.ctx);
    } catch {}
    for (const t of inst.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    for (const off of inst.unsubscribes) off();
    map.delete(pluginId);
  }

  setStartError(sessionId, pluginId, msg) {
    if (!this.startErrors.has(sessionId)) this.startErrors.set(sessionId, new Map());
    this.startErrors.get(sessionId).set(pluginId, msg);
  }

  clearStartError(sessionId, pluginId) {
    this.startErrors.get(sessionId)?.delete(pluginId);
  }

  getStartError(sessionId, pluginId) {
    return this.startErrors.get(sessionId)?.get(pluginId) || null;
  }

  resolvePluginState(session, plugin) {
    const perSession = this.config.getPluginState(session.id, plugin.id);
    const globalDefault = this.config.getPluginDefault(plugin.id);
    return {
      enabled: perSession?.enabled ?? globalDefault?.enabled ?? plugin.defaultEnabled !== false,
      config: { ...(plugin.defaultConfig || {}), ...(globalDefault?.config || {}), ...(perSession?.config || {}) },
    };
  }

  getInstance(sessionId, pluginId) {
    return this.instances.get(sessionId)?.get(pluginId) || null;
  }
}
