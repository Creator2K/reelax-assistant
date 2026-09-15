// 会话管理器：配置 <-> 运行时实例的双向同步
import { Session } from "./session.js";

export class SessionManager {
  constructor({ config, logger, bus, pluginHost, baseUrl }) {
    this.config = config;
    this.log = logger;
    this.bus = bus;
    this.pluginHost = pluginHost;
    this.baseUrl = baseUrl;
    this.sessions = new Map(); // id -> Session
    // 从配置恢复实例
    for (const record of config.listSessions()) {
      this.sessions.set(record.id, this.createRuntime(record));
    }
  }

  createRuntime(record) {
    return new Session({
      record,
      config: this.config,
      logger: this.log,
      bus: this.bus,
      pluginHost: this.pluginHost,
      baseUrl: this.baseUrl,
    });
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON());
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  require(id) {
    const s = this.get(id);
    if (!s) {
      const err = new Error("会话不存在");
      err.statusCode = 404;
      throw err;
    }
    return s;
  }

  async create(input) {
    if (input.authType !== "cookie" && (!input.email || !input.password)) {
      const err = new Error("账号密码方式需要 email 和 password");
      err.statusCode = 400;
      throw err;
    }
    if (input.authType === "cookie" && !input.cookie) {
      const err = new Error("Cookie 方式需要 cookie 字段");
      err.statusCode = 400;
      throw err;
    }
    const record = this.config.createSession(input);
    const session = this.createRuntime(record);
    this.sessions.set(record.id, session);
    this.log.info("会话", `新增会话「${record.label}」（${record.authType === "cookie" ? "Cookie 导入" : "账号密码"}）`);
    if (session.record.autoStart) {
      session.start().catch(() => {});
    }
    return session.toJSON();
  }

  async update(id, patch) {
    const session = this.require(id);
    const wasRunning = session.status !== "stopped";
    const restart = wasRunning && (patch.email !== undefined || patch.password !== undefined || patch.cookie !== undefined);
    if (wasRunning && restart) await session.stop("更新凭证");
    this.config.updateSession(id, patch);
    // 同步凭证到运行时客户端
    if (patch.email !== undefined) session.client.email = patch.email;
    if (patch.password !== undefined) session.client.password = patch.password;
    if (patch.cookie !== undefined) session.client.cookie = patch.cookie;
    if (restart) {
      session.client.proof = null;
      session.start().catch(() => {});
    }
    return session.toJSON();
  }

  async remove(id) {
    const session = this.require(id);
    await session.stop("删除会话");
    this.sessions.delete(id);
    this.config.deleteSession(id);
    return true;
  }

  async start(id) {
    const session = this.require(id);
    await session.start();
    return session.toJSON();
  }

  async stop(id) {
    const session = this.require(id);
    await session.stop("手动停止");
    return session.toJSON();
  }

  /** 服务启动时恢复所有 autoStart 会话（错峰启动） */
  async startAll() {
    const targets = [...this.sessions.values()].filter((s) => s.record.autoStart);
    if (!targets.length) return;
    this.log.info("会话", `恢复 ${targets.length} 个自动启动会话`);
    for (const [i, session] of targets.entries()) {
      setTimeout(() => session.start().catch(() => {}), i * 2500);
    }
  }

  async stopAll() {
    for (const session of this.sessions.values()) {
      await session.stop("服务关闭").catch(() => {});
    }
  }
}
