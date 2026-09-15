// REST + WebSocket 客户端
let authToken = localStorage.getItem("ra_token") || "";

export function setAuthToken(t) {
  authToken = t || "";
  if (authToken) localStorage.setItem("ra_token", authToken);
  else localStorage.removeItem("ra_token");
}

export function getAuthToken() {
  return authToken;
}

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authToken) headers["Authorization"] = "Bearer " + authToken;
  const resp = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  if (!resp.ok) {
    const err = new Error(data?.error?.message || `请求失败（${resp.status}）`);
    err.status = resp.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

export const api = {
  status: () => request("/api/status"),
  sessions: () => request("/api/sessions"),
  session: (id) => request(`/api/sessions/${id}`),
  createSession: (body) => request("/api/sessions", { method: "POST", body }),
  updateSession: (id, body) => request(`/api/sessions/${id}`, { method: "PATCH", body }),
  deleteSession: (id) => request(`/api/sessions/${id}`, { method: "DELETE" }),
  startSession: (id) => request(`/api/sessions/${id}/start`, { method: "POST" }),
  stopSession: (id) => request(`/api/sessions/${id}/stop`, { method: "POST" }),
  loginSession: (id) => request(`/api/sessions/${id}/login`, { method: "POST" }),
  sessionState: (id) => request(`/api/sessions/${id}/state`),
  setSessionPlugin: (id, pluginId, body) => request(`/api/sessions/${id}/plugins/${pluginId}`, { method: "PATCH", body }),
  plugins: () => request("/api/plugins"),
  setPluginDefault: (id, body) => request(`/api/plugins/${id}`, { method: "PATCH", body }),
  importPlugin: (body) => request("/api/plugins/import", { method: "POST", body }),
  unloadPlugin: (id) => request(`/api/plugins/${id}`, { method: "DELETE" }),
  logs: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return request("/api/logs?" + q.toString());
  },
};

/** 订阅 WS：返回 { close }，自动重连 */
export function connectWs({ onSessions, onLog, onEvent, onStatus }) {
  let ws = null;
  let closed = false;
  let retryMs = 1500;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws` + (authToken ? `?token=${encodeURIComponent(authToken)}` : "");
    ws = new WebSocket(url);

    ws.onopen = () => {
      retryMs = 1500;
      onStatus?.(true);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "sessions") onSessions?.(msg.data);
        else if (msg.type === "log") onLog?.(msg.data);
        else if (msg.type === "event") onEvent?.(msg.data);
      } catch {
        /* 忽略坏帧 */
      }
    };
    ws.onclose = () => {
      onStatus?.(false);
      if (!closed) {
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 1.6, 10000);
      }
    };
    ws.onerror = () => ws?.close();
  };

  open();
  return {
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}
