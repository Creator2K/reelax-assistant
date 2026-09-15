// 会话：一个游戏账号的运行时（签名客户端 + 插件实例 + 状态聚合）
import { GameClient } from "./client.js";
import { jitter } from "../util.js";

export const SESSION_STATUS = {
  STOPPED: "stopped",
  STARTING: "starting",
  ONLINE: "online",
  RECONNECTING: "reconnecting",
  ERROR: "error",
  EXPIRED: "expired",
};

export class Session {
  constructor({ record, config, logger, bus, pluginHost, baseUrl }) {
    this.id = record.id;
    this.record = record; // 配置存储引用（label/auth 等）
    this.config = config;
    this.log = logger.child({ sessionId: record.id });
    this.bus = bus;
    this.pluginHost = pluginHost;
    this.baseUrl = baseUrl;

    this.client = new GameClient({
      baseUrl,
      email: record.email,
      password: record.password,
      cookie: record.cookie,
      log: this.log,
    });

    this.status = SESSION_STATUS.STOPPED;
    this.lastError = null;
    this.startedAt = null;
    // 运行时聚合（由插件通过 report* 方法上报）
    this.runtime = {
      run: null, // 最近一次钓鱼 run 快照
      lastSyncAt: 0,
      lastSettlement: null,
      stats: { startedAt: 0, syncs: 0, castsResolved: 0, gold: 0, experience: 0, fishCount: 0 },
    };
  }

  get label() {
    return this.record.label;
  }

  // ---------- 生命周期 ----------

  async start() {
    if (this.status === SESSION_STATUS.ONLINE || this.status === SESSION_STATUS.STARTING) return;
    this.status = SESSION_STATUS.STARTING;
    this.lastError = null;
    this.startedAt = Date.now();
    this.runtime.stats.startedAt = this.startedAt;
    this.log.info("会话", `启动会话「${this.label}」`);
    try {
      // 验证 / 建立会话
      await this.client.ensureSession();
      await this.pluginHost.startSession(this);
      this.status = SESSION_STATUS.ONLINE;
      this.bus.emit("session:started", { sessionId: this.id });
      this.log.info("会话", `会话「${this.label}」已启动`);
    } catch (err) {
      const expired = err?.code === "SESSION_EXPIRED" || err?.status === 401 || err?.status === 403;
      this.status = expired ? SESSION_STATUS.EXPIRED : SESSION_STATUS.ERROR;
      this.startedAt = null;
      this.lastError = err?.message || String(err);
      this.log.error("会话", `启动失败：${this.lastError}`);
      throw err;
    }
  }

  async stop(reason = "手动停止") {
    if (this.status === SESSION_STATUS.STOPPED) return;
    this.log.info("会话", `停止会话「${this.label}」：${reason}`);
    await this.pluginHost.stopSession(this);
    this.status = SESSION_STATUS.STOPPED;
    this.startedAt = null;
    this.bus.emit("session:stopped", { sessionId: this.id, reason });
  }

  /** 插件报告状态（保持在线引擎调用） */
  setStatus(status, detail = null) {
    if (this.status !== status) {
      this.status = status;
      this.bus.emit("session:status", { sessionId: this.id, status });
    }
    if (detail !== null && detail !== undefined) this.lastError = detail;
  }

  /** 上报钓鱼 run 快照（同一 run 增量合并，保留 state 有而 sync 无的字段） */
  reportRun(run) {
    if (!run) return;
    const prev = this.runtime.run;
    this.runtime.run = prev && prev.id === run.id ? { ...prev, ...run, totalCasts: run.totalCasts ?? prev.totalCasts } : run;
  }

  reportSync({ run, settlement, playerPatch }) {
    this.reportRun(run);
    this.runtime.lastSyncAt = Date.now();
    this.runtime.lastSettlement = settlement || null;
    const st = this.runtime.stats;
    st.syncs++;
    if (settlement) {
      st.castsResolved += settlement.castsResolved || 0;
      st.gold += settlement.directGoldNet ?? settlement.gold ?? 0;
      st.experience += settlement.experience || 0;
      st.fishCount += (settlement.fish || []).reduce((acc, f) => acc + (f.quantity || 0), 0);
    }
    this.bus.emit("fishing:sync", { sessionId: this.id, run: this.runtime.run, settlement, playerPatch: playerPatch || null });
  }

  reportError(message) {
    this.lastError = message;
    this.bus.emit("session:error", { sessionId: this.id, message });
  }

  // ---------- 序列化 ----------

  toJSON() {
    const client = this.client.snapshot();
    return {
      id: this.id,
      label: this.record.label,
      authType: this.record.authType,
      autoStart: this.record.autoStart,
      status: this.status,
      lastError: this.lastError,
      startedAt: this.startedAt,
      email: client.email,
      hasCookie: client.hasCookie,
      hasCredentials: client.hasCredentials,
      proofExpiresAt: client.proofExpiresAt,
      frontendVersion: client.frontendVersion,
      player: client.player,
      publicId: client.publicId,
      run: this.runtime.run,
      lastSyncAt: this.runtime.lastSyncAt || null,
      lastSettlement: this.runtime.lastSettlement,
      stats: this.runtime.stats,
      plugins: this.pluginSummary(),
    };
  }

  pluginSummary() {
    const map = this.pluginHost.instances.get(this.id);
    const out = {};
    for (const p of this.pluginHost.registry.values()) {
      const state = this.pluginHost.resolvePluginState(this, p);
      out[p.id] = {
        enabled: state.enabled,
        config: state.config,
        running: Boolean(map?.has(p.id)),
        startError: this.pluginHost.getStartError(this.id, p.id),
      };
    }
    return out;
  }
}

/** 引擎等待辅助：等待到目标时间，每秒检查 abort */
export async function waitAbortable(targetMs, isAborted, tickMs = 1000) {
  for (;;) {
    if (isAborted()) return false;
    const remain = targetMs - Date.now();
    if (remain <= 0) return true;
    await new Promise((r) => setTimeout(r, Math.min(remain, tickMs)));
  }
}

export { jitter };
