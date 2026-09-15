// HTTP 服务：REST API + 静态托管前端（web/dist）+ SPA 回退
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export function createHttpServer({ port, host, authToken, logger, sessionManager, pluginHost, configStore, version, startedAt }) {
  const log = logger;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    res.setHeader("X-Content-Type-Options", "nosniff");

    try {
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;

      if (pathname.startsWith("/api/")) {
        // 鉴权
        if (authToken) {
          const token =
            (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-auth-token"] || url.searchParams.get("token");
          if (token !== authToken) {
            return sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "未授权：请在控制台设置访问令牌" } });
          }
        }
        const method = req.method.toUpperCase();
        const body = method === "POST" || method === "PATCH" || method === "PUT" ? await readBody(req) : {};
        const ok = await route({ method, pathname, query: url.searchParams, body, res });
        if (ok) {
          log.debug("HTTP", `${method} ${pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
          return;
        }
        return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `接口不存在：${method} ${pathname}` } });
      }

      // 静态文件（web/dist）
      serveStatic(pathname, res);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) log.error("HTTP", `${req.method} ${req.url} 失败：${err?.stack || err}`);
      sendJson(res, status, { error: { code: err.code || "ERROR", message: err?.message || String(err) } });
    }
  });

  // ---------- 路由 ----------

  async function route({ method, pathname, query, body, res }) {
    const seg = pathname.split("/").filter(Boolean); // ["api", ...]
    const p = "/" + seg.slice(1).join("/");

    if (method === "GET" && p === "/status") {
      const sessions = sessionManager.list();
      return sendJson(res, 200, {
        version,
        startedAt,
        uptime: Date.now() - startedAt,
        baseUrl: configStore.data.baseUrl,
        sessions: sessions.length,
        online: sessions.filter((s) => s.status === "online").length,
        running: sessions.filter((s) => s.status !== "stopped").length,
      });
    }

    if (seg[1] === "sessions") {
      // /api/sessions...
      const rest = seg.slice(2); // [id, sub...] 或 []
      if (rest.length === 0) {
        if (method === "GET") return sendJson(res, 200, sessionManager.list());
        if (method === "POST") return sendJson(res, 200, await sessionManager.create(body));
      }
      if (rest.length >= 1) {
        const id = rest[0];
        if (rest.length === 1) {
          if (method === "GET") return sendJson(res, 200, sessionManager.require(id).toJSON());
          if (method === "PATCH") return sendJson(res, 200, await sessionManager.update(id, body));
          if (method === "DELETE") return sendJson(res, 200, { ok: await sessionManager.remove(id) });
        }
        if (rest.length === 2 && method === "POST") {
          if (rest[1] === "start") return sendJson(res, 200, await sessionManager.start(id));
          if (rest[1] === "stop") return sendJson(res, 200, await sessionManager.stop(id));
          if (rest[1] === "login") {
            const session = sessionManager.require(id);
            await session.client.ensureSession();
            return sendJson(res, 200, { ok: true, player: session.client.snapshot() });
          }
        }
        if (rest.length === 2 && rest[1] === "state" && method === "GET") {
          const session = sessionManager.require(id);
          const state = await session.client.fishingState();
          return sendJson(res, 200, state);
        }
        if (rest.length === 3 && rest[1] === "plugins" && method === "PATCH") {
          const pluginId = rest[2];
          const session = sessionManager.require(id);
          if (!pluginHost.registry.has(pluginId)) {
            throw Object.assign(new Error("插件未注册"), { statusCode: 404, code: "PLUGIN_NOT_FOUND" });
          }
          const patch = {};
          if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
          if (body.config !== undefined) patch.config = body.config;
          configStore.setPluginState(id, pluginId, patch);
          const result = await pluginHost.restartPlugin(session, pluginId);
          const summary = session.pluginSummary()[pluginId] || { ok: true };
          return sendJson(res, 200, { ...summary, ok: result.ok, error: result.error || summary.startError || null });
        }
      }
    }

    if (p === "/plugins" && method === "GET") {
      return sendJson(res, 200, pluginHost.list());
    }
    let m = p.match(/^\/plugins\/import$/);
    if (m && method === "POST") {
      const created = await pluginHost.importFromCode({ code: body.code, filename: body.filename });
      return sendJson(res, 200, created);
    }
    m = p.match(/^\/plugins\/([^/]+)$/);
    if (m && method === "DELETE") {
      return sendJson(res, 200, { ok: await pluginHost.unload(m[1]) });
    }
    if (m && method === "PATCH") {
      return sendJson(res, 200, configStore.setPluginDefault(m[1], body));
    }

    if (p === "/logs" && method === "GET") {
      return sendJson(res, 200, logger.recent({
        sessionId: query.get("sessionId") || null,
        minLevel: query.get("level") || "debug",
        search: query.get("search") || "",
        limit: Math.min(Number(query.get("limit")) || 500, 2000),
      }));
    }

    return false;
  }

  // ---------- 静态资源 ----------

  function serveStatic(pathname, res) {
    const distDir = path.resolve(__dirname, "../../../web/dist");
    if (!fs.existsSync(distDir)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Reelax Assistant</h1><p>前端尚未构建：请先执行 <code>npm run build</code>，或使用 <code>npm run dev</code>（Vite 5173 端口）。</p>");
      return;
    }
    let file = pathname === "/" ? "/index.html" : pathname;
    let full = path.join(distDir, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (!full.startsWith(distDir)) {
      res.writeHead(403);
      return res.end();
    }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      full = path.join(distDir, "index.html"); // SPA 回退
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
    });
    fs.createReadStream(full).pipe(res);
  }

  server.on("error", (err) => {
    log.error("HTTP", `监听失败（${err.code || err.message}）。可用环境变量 PORT 修改端口。`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    log.info("HTTP", `控制台已启动：http://localhost:${port}${authToken ? "（已启用访问令牌）" : ""}`);
  });

  return server;
}

function sendJson(res, status, data) {
  // 先完成序列化再写响应头：序列化失败时还能返回正常的 500
  const body = JSON.stringify(data);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("请求体不是有效的 JSON"), { statusCode: 400, code: "INVALID_JSON" }));
      }
    });
    req.on("error", reject);
  });
}
