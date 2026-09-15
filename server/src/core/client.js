// 游戏签名客户端：负责登录会话、请求签名（x-arcane-request-proof）、proof 自动续期
//
// 协议要点（详见 docs/PROTOCOL.md）：
//  1. POST /api/auth/login {email,password} -> Set-Cookie: arcane_session=...
//  2. 任意响应头 x-arcane-request-proof 即 HMAC 密钥（base64url(JSON{version,expiresAt}).sig）
//  3. 受保护请求需携带：
//     x-arcane-request-proof      密钥本体
//     x-arcane-request-timestamp  毫秒时间戳（用 x-arcane-server-time 校正）
//     x-arcane-request-signature  base64url(HMAC-SHA256("v1\nMETHOD\npath?query\nts\nbody"))
//  4. proof 会过期（约 10~15 分钟），过期后签名请求失败 -> 重新 GET /api/me 续期即可
import crypto from "node:crypto";
import { newIdempotencyKey, parseTime } from "../util.js";

const SIGNED_SKIP = new Set(["/api/auth/login", "/api/me", "/api/meta/frontend-release"]);

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export class GameClientError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "GameClientError";
    this.status = status;
    this.code = code;
  }
}

export class GameClient {
  constructor({ baseUrl, email = "", password = "", cookie = "", log = console, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.email = email;
    this.password = password;
    this.cookie = cookie || "";
    this.log = log;

    this.proof = null;
    this.proofExpiresAt = 0;
    this.serverTimeOffset = 0;
    this.frontendVersion = "";
    this.player = null;
    this.publicIdentity = null;

    this.lastRequestAt = 0;
    this.consecutiveErrors = 0;
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  get hasCredentials() {
    return Boolean(this.email && this.password);
  }

  now() {
    return Date.now() + this.serverTimeOffset;
  }

  // ---------- 会话引导 ----------

  async login() {
    if (!this.hasCredentials) throw new GameClientError("未配置邮箱或密码，无法登录", { code: "NO_CREDENTIALS" });
    const data = await this.request("/api/auth/login", {
      method: "POST",
      body: { email: this.email, password: this.password },
      idempotent: true,
      _relogin: false,
    });
    this.log.info("登录", `账号 ${this.email} 登录成功`);
    return data;
  }

  /** 刷新 proof（GET /api/me，无需签名） */
  async refreshProof() {
    const resp = await this.raw("/api/me", { headers: { "cache": "no-store" } });
    const data = await this.readJson(resp);
    if (resp.status === 401 || resp.status === 403) {
      throw new GameClientError("会话已失效", { status: resp.status, code: "SESSION_EXPIRED" });
    }
    if (!resp.ok) {
      throw new GameClientError(data?.error?.message || `刷新会话失败（${resp.status}）`, { status: resp.status });
    }
    this.absorb(resp, data);
    return data;
  }

  /** 确保会话可用：有 cookie 先验证，失效且有凭证则重新登录 */
  async ensureSession() {
    try {
      const me = await this.refreshProof();
      return me;
    } catch (err) {
      if (err?.code === "SESSION_EXPIRED" && this.hasCredentials) {
        this.log.warn("会话", "Cookie 已失效，正在使用账号密码重新登录");
        return await this.login();
      }
      throw err;
    }
  }

  // ---------- 请求签名 ----------

  sign(method, path, ts, bodyStr) {
    const payload = ["v1", method.toUpperCase(), path, ts, bodyStr].join("\n");
    const sig = crypto.createHmac("sha256", this.proof).update(payload, "utf8").digest();
    return b64urlEncode(new Uint8Array(sig));
  }

  /** 统一请求入口：自动签名、proof 续期、会话失效重登（_relogin 防递归：登录请求本身禁止再触发重登） */
  async request(path, { method = "GET", body, headers = {}, idempotent = false, extraHeaders = {}, _relogin = true } = {}) {
    // 同一个逻辑请求的重试必须复用幂等键，否则服务端可能把重试当作第二次操作。
    const idempotencyKey = idempotent ? newIdempotencyKey() : null;
    if (!this.proof && !SIGNED_SKIP.has(path)) {
      await this.ensureSession();
    }
    if (this.proof && this.proofExpiresAt && this.now() > this.proofExpiresAt - 60_000) {
      try {
        await this.refreshProof();
      } catch (err) {
        this.log.warn("会话", `proof 续期失败：${err?.message || err}`);
      }
    }

    const attempt = async (isRetry) => {
      const ts = String(this.now());
      const bodyStr = body !== undefined ? JSON.stringify(body) : "";
      const h = {
        Accept: "application/json",
        "x-frontend-version": this.frontendVersion || "0.18.0",
        ...headers,
        ...extraHeaders,
      };
      if (body !== undefined) h["Content-Type"] = "application/json";
      if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
      if (this.cookie) h["Cookie"] = this.cookie;
      const needSign = this.proof && !SIGNED_SKIP.has(path);
      if (needSign) {
        h["x-arcane-request-proof"] = this.proof;
        h["x-arcane-request-timestamp"] = ts;
        h["x-arcane-request-signature"] = this.sign(method, path, ts, bodyStr);
      }

      let resp;
      try {
        resp = await this.raw(path, { method, headers: h, body: body !== undefined ? bodyStr : undefined });
      } catch (err) {
        this.consecutiveErrors++;
        throw new GameClientError(`网络错误：${err?.cause?.code || err?.message || err}`, { code: "NETWORK" });
      }

      const data = await this.readJson(resp);
      this.absorb(resp, data);
      this.lastRequestAt = Date.now();

      if (resp.ok) {
        this.consecutiveErrors = 0;
        return data;
      }

      const msg = data?.error?.message || data?.message || "";
      const signatureIssue =
        resp.status === 401 || resp.status === 403 || /SIGNATURE/i.test(JSON.stringify(data)) || /签名/.test(msg);

      if (signatureIssue && !isRetry) {
        // proof 过期 / 会话失效：先续期，续期失败且有凭证则重新登录，然后重试一次
        try {
          await this.refreshProof();
        } catch (err) {
          if (this.hasCredentials && _relogin) {
            await this.login();
          } else {
            throw new GameClientError(`会话已失效且无法自动重登：${err?.message || err}`, {
              status: resp.status,
              code: "SESSION_EXPIRED",
            });
          }
        }
        return attempt(true);
      }

      throw new GameClientError(msg || `请求失败（${resp.status}）`, {
        status: resp.status,
        code: data?.error?.code || "",
      });
    };

    return attempt(false);
  }

  // ---------- 便捷封装 ----------

  me() {
    return this.request("/api/me");
  }
  fishingState() {
    return this.request("/api/fishing/state");
  }
  fishingStart() {
    return this.request("/api/fishing/start", { method: "POST", idempotent: true });
  }
  fishingStop() {
    return this.request("/api/fishing/stop", { method: "POST", idempotent: true });
  }
  fishingRefill() {
    return this.request("/api/fishing/refill", { method: "POST", idempotent: true });
  }
  fishingSync(snapshotKey) {
    return this.request("/api/fishing/sync", {
      method: "POST",
      idempotent: true,
      extraHeaders: { "X-Fishing-Run-Snapshot-Key": snapshotKey || "missing" },
    });
  }
  routeTravel() {
    return this.request("/api/route-assistant/travel", { method: "POST", idempotent: true });
  }
  dailyCheckInStatus() {
    return this.request("/api/daily-check-in");
  }
  dailyCheckInClaim() {
    return this.request("/api/daily-check-in/claim", { method: "POST", idempotent: true });
  }
  statsAllocate(body) {
    return this.request("/api/player/stats/allocate", { method: "POST", body, idempotent: true });
  }
  statsReset() {
    return this.request("/api/player/stats/reset", { method: "POST", idempotent: true });
  }
  biomeTravel(biomeId) {
    return this.request("/api/player/current-biome", { method: "PUT", body: { biomeId } });
  }
  biomes() {
    return this.request("/api/biomes");
  }
  mastery() {
    return this.request("/api/mastery");
  }
  masteryContributeAll(biomeId, excludedRarities) {
    return this.request(`/api/mastery/${encodeURIComponent(biomeId)}/contribute-all`, {
      method: "POST",
      body: { excludedRarities },
      idempotent: true,
    });
  }
  worldBoss() {
    return this.request("/api/events/world-boss");
  }
  worldBossSelect(stat) {
    return this.request("/api/events/world-boss/selection", { method: "POST", body: { stat }, idempotent: true });
  }
  tournamentsOverview() {
    return this.request("/api/tournaments/overview");
  }
  guildTournamentsOverview() {
    return this.request("/api/guild-tournaments/overview");
  }
  tournamentRegister(id) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/register`, { method: "POST", body: {}, idempotent: true });
  }
  guildsMe() {
    return this.request("/api/guilds/me");
  }
  gearInventory(cursor) {
    return this.request("/api/inventory/gear" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""));
  }
  gearSalePreview(rules) {
    return this.request("/api/inventory/gear/sale-preview", { method: "POST", body: { rules } });
  }
  gearSell(gearIds) {
    return this.request("/api/inventory/gear/sell", { method: "POST", body: { gearIds }, idempotent: true });
  }
  sellFish(items) {
    return this.request("/api/inventory/fish/sell", { method: "POST", body: { items }, idempotent: true });
  }
  inventoryFish() {
    return this.request("/api/inventory/fish");
  }

  // ---------- 底层 ----------

  async raw(path, { method = "GET", headers = {}, body } = {}) {
    const url = this.baseUrl + path;
    return this.fetchImpl(url, {
      method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Origin: this.baseUrl,
        Referer: this.baseUrl + "/",
        ...headers,
      },
      body,
      redirect: "manual",
    });
  }

  async readJson(resp) {
    const text = await resp.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return { raw: text.slice(0, 500) };
    }
  }

  /** 从响应头吸收 proof / 服务器时间 / 版本 / Cookie */
  absorb(resp, data) {
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    if (setCookies.length) {
      this.cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    }
    const serverTime = resp.headers.get("x-arcane-server-time");
    if (serverTime) {
      const st = Number(serverTime);
      if (Number.isSafeInteger(st) && st > 0) this.serverTimeOffset = st - Date.now();
    }
    const proof = resp.headers.get("x-arcane-request-proof");
    if (proof) this.setProof(proof);
    const fe = resp.headers.get("x-frontend-version");
    if (fe) this.frontendVersion = fe;

    if (data && typeof data === "object") {
      if (data.player) this.player = data.player;
      if (data.publicIdentity) this.publicIdentity = data.publicIdentity;
      if (data.serverTime) {
        const st = parseTime(data.serverTime);
        if (st) this.serverTimeOffset = st - Date.now();
      }
    }
  }

  setProof(proof) {
    this.proof = proof;
    let exp = 0;
    try {
      const payloadB64 = proof.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      exp = JSON.parse(atob2(payloadB64)).expiresAt || 0;
    } catch {
      exp = 0;
    }
    this.proofExpiresAt = exp;
  }

  /** 供 UI 展示的安全快照（不包含密码） */
  snapshot() {
    return {
      email: this.email || null,
      hasCookie: Boolean(this.cookie),
      hasCredentials: this.hasCredentials,
      proofExpiresAt: this.proofExpiresAt || null,
      frontendVersion: this.frontendVersion || null,
      player: this.player
        ? {
            nickname: this.player.nickname,
            level: this.player.level,
            gold: this.player.gold,
            relics: this.player.relics,
            fragments: this.player.fragments,
          }
        : null,
      publicId: this.publicIdentity?.publicId ?? null,
    };
  }
}

function atob2(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(pad, "base64").toString("binary");
}
