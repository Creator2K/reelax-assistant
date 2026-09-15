// 服务入口：装配 配置 / 日志 / 插件 / 会话 / HTTP+WS
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.js";
import { Bus } from "./core/bus.js";
import { ConfigStore } from "./config.js";
import { PluginHost } from "./core/plugin-host.js";
import { SessionManager } from "./core/session-manager.js";
import { createHttpServer } from "./api/http.js";
import { WsHub } from "./api/ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";
const startedAt = Date.now();

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err?.stack || err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack || err);
});

async function main() {
  const logger = new Logger(4000);
  const bus = new Bus();
  const dataDir = path.resolve(__dirname, "../data");
  const configStore = new ConfigStore(dataDir);
  const pluginHost = new PluginHost({ config: configStore, logger, bus, externalDir: path.join(dataDir, "plugins") });

  await pluginHost.loadAll({
    builtinDir: path.join(__dirname, "plugins"),
    externalDir: path.join(dataDir, "plugins"),
  });

  const sessionManager = new SessionManager({
    config: configStore,
    logger,
    bus,
    pluginHost,
    baseUrl: configStore.data.baseUrl,
  });

  const server = createHttpServer({
    port: configStore.data.port,
    host: configStore.data.host,
    authToken: configStore.data.authToken,
    logger,
    sessionManager,
    pluginHost,
    configStore,
    version: VERSION,
    startedAt,
  });

  const wsHub = new WsHub({
    server,
    authToken: configStore.data.authToken,
    logger,
    bus,
    sessionManager,
  });

  // 恢复自动启动的会话（错峰，避免并发登录触发风控）
  await sessionManager.startAll();

  const shutdown = async (signal) => {
    logger.info("服务", `收到 ${signal}，正在关闭…`);
    try {
      await sessionManager.stopAll();
    } catch {}
    wsHub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("启动失败：", err);
  process.exit(1);
});
