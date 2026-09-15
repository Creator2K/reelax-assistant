// WebSocket 推送：/ws?token=xxx
// 消息格式：{ type, data, t }
//  - log        日志行（实时）
//  - event      内部事件（session:started / fishing:sync / ...）
//  - sessions   会话快照（每 2s 定时 + 变更即推）
import { WebSocketServer } from "ws";

export class WsHub {
  constructor({ server, authToken, logger, bus, sessionManager }) {
    this.wss = new WebSocketServer({ noServer: true });
    this.authtoken = authToken;
    this.clients = new Set();

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/ws") return socket.destroy();
      const token = url.searchParams.get("token") || req.headers["x-auth-token"];
      if (this.authtoken && token !== this.authtoken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
      ws.send(JSON.stringify({ type: "hello", data: { serverTime: Date.now() } }));
      // 连接即推一次全量快照
      this.sendSessions(ws);
    });

    // 心跳清理
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30_000);

    // 日志实时推送
    this.unsubLog = logger.subscribe((entry) => this.broadcast("log", entry));

    // 内部事件推送 + 状态变化立即刷新快照
    for (const evt of ["session:started", "session:stopped", "session:status", "session:error"]) {
      bus.on(evt, (payload) => {
        this.broadcast("event", { event: evt, ...payload });
        this.pushSessions();
      });
    }
    bus.on("fishing:sync", (payload) => {
      this.broadcast("event", { event: "fishing:sync", ...payload });
      this.pushSessions();
    });

    // 定时全量快照（统计数据变化）
    this.snapshotTimer = setInterval(() => this.pushSessions(), 2000);
    this.sessionManager = sessionManager;
  }

  pushSessions() {
    if (!this.sessionManager || !this.clients.size) return;
    try {
      const data = this.sessionManager.list();
      const json = JSON.stringify(data);
      if (json === this._lastSessionsJson) return; // 无变化不推送，减少前端无谓重渲染
      this._lastSessionsJson = json;
      this.broadcast("sessions", data);
    } catch {
      /* 会话序列化失败不应影响推送 */
    }
  }

  sendSessions(ws) {
    if (!this.sessionManager || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({ type: "sessions", data: this.sessionManager.list(), t: Date.now() }));
    } catch {
      this.clients.delete(ws);
    }
  }

  broadcast(type, data) {
    if (!this.clients.size) return;
    const msg = JSON.stringify({ type, data, t: Date.now() });
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        try {
          ws.send(msg);
        } catch {
          this.clients.delete(ws);
        }
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    clearInterval(this.snapshotTimer);
    this.unsubLog?.();
    for (const ws of this.clients) ws.terminate();
    this.wss.close();
  }
}
