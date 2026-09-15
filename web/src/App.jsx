// 应用外壳：侧边导航 + 页面路由 + 全局数据（WS 实时推送）
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, connectWs, getAuthToken, setAuthToken } from "./api.js";
import { Modal, Icons, ConfirmHost } from "./components/ui.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Sessions from "./pages/Sessions.jsx";
import Plugins from "./pages/Plugins.jsx";
import Logs from "./pages/Logs.jsx";

const NAV = [
  { key: "dashboard", label: "总览", icon: Icons.grid },
  { key: "sessions", label: "会话管理", icon: Icons.user },
  { key: "plugins", label: "插件中心", icon: Icons.plug },
  { key: "logs", label: "运行日志", icon: Icons.list },
];

function useHashRoute() {
  const [route, setRoute] = useState(location.hash.replace("#/", "") || "dashboard");
  useEffect(() => {
    const fn = () => setRoute(location.hash.replace("#/", "") || "dashboard");
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  return [route, (r) => (location.hash = "#/" + r)];
}

/* ---------- 夜间模式 ---------- */

const THEME_KEY = "ra_theme";

/** 首次渲染前同步到 <html data-theme>，避免刷新时闪白/闪黑 */
export function initTheme() {
  let theme = localStorage.getItem(THEME_KEY);
  if (theme !== "dark" && theme !== "light") {
    theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.dataset.theme = theme;
  return theme;
}

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || initTheme());
  const toggle = () =>
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  return [theme, toggle];
}

export default function App() {
  const [route, navigate] = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  const [sessions, setSessions] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [status, setStatus] = useState(null);
  const [wsOk, setWsOk] = useState(false);
  const [needToken, setNeedToken] = useState(false);
  const logBufferRef = useRef([]);
  const [logTick, setLogTick] = useState(0);

  const loadAll = async () => {
    try {
      const [s, p, st] = await Promise.all([api.sessions(), api.plugins(), api.status()]);
      setSessions(s);
      setPlugins(p);
      setStatus(st);
    } catch (err) {
      if (err.status === 401) setNeedToken(true);
    }
  };

  useEffect(() => {
    loadAll();
    const ws = connectWs({
      onSessions: (list) => setSessions(list),
      onLog: (entry) => {
        logBufferRef.current.push(entry);
        if (logBufferRef.current.length > 1200) logBufferRef.current.splice(0, 400);
        setLogTick((t) => t + 1);
      },
      onEvent: (ev) => {
        if (ev.event === "session:error") loadAll();
      },
      onStatus: setWsOk,
    });
    return () => ws.close();
  }, []);

  const ctx = useMemo(
    () => ({ sessions, plugins, status, wsOk, logs: logBufferRef.current, logTick, refresh: loadAll }),
    [sessions, plugins, status, wsOk, logTick]
  );

  const page = { dashboard: Dashboard, sessions: Sessions, plugins: Plugins, logs: Logs }[route] || Dashboard;
  const Page = page;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="22" height="22" viewBox="0 0 64 64" fill="none">
              <path d="M20 42c8 6 16 6 24 0M32 14v20m0 0a7 7 0 1 0 7 7" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" />
            </svg>
          </div>
          <div className="brand-text">
            <div className="brand-name">Reelax 辅助</div>
            <div className="brand-sub">Arcane Assistant</div>
          </div>
        </div>
        {NAV.map((n) => (
          <button key={n.key} className={"nav-item" + (route === n.key ? " active" : "")} onClick={() => navigate(n.key)}>
            {n.icon}
            <span>{n.label}</span>
          </button>
        ))}
        <div className="sidebar-footer">
          <div className="row" style={{ gap: 7 }}>
            <span className={"ws-dot " + (wsOk ? "on" : "off")} />
            <span>{wsOk ? "实时连接正常" : "实时连接断开"}</span>
          </div>
          <div>{status ? `v${status.version} · 运行 ${fmtUptime(status.uptime)}` : "…"}</div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="btn ghost sm" style={{ padding: "2px 0", color: "var(--text-3)" }} onClick={() => setNeedToken(true)}>
              访问令牌
            </button>
            <button
              className="theme-btn"
              title={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
              aria-label={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
              onClick={toggleTheme}
            >
              {theme === "dark" ? Icons.sun : Icons.moon}
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <Page ctx={ctx} />
      </main>

      {needToken && (
        <TokenModal
          onClose={() => setNeedToken(false)}
          onSaved={() => {
            setNeedToken(false);
            loadAll();
          }}
        />
      )}
      <ConfirmHost />
    </div>
  );
}

function TokenModal({ onClose, onSaved }) {
  const [token, setToken] = useState(getAuthToken());
  return (
    <Modal title="访问令牌" desc="如果服务端启用了 authToken，请在此填写。令牌只保存在本浏览器。" onClose={onClose}>
      <div className="field">
        <label className="field-label">Bearer Token</label>
        <input className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder="留空表示未启用鉴权" />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button
          className="btn primary"
          onClick={() => {
            setAuthToken(token.trim());
            location.reload();
          }}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}天${h}时`;
  if (h) return `${h}时${m}分`;
  return `${m}分`;
}
