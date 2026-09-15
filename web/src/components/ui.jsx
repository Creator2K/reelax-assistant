// 通用小组件：图标 / 状态徽标 / 开关 / 分段控件 / 模态 / 统计卡 / 配置表单
import React, { useEffect, useState } from "react";

/* ---------- 图标（SF 风格线性图标） ---------- */

const I = ({ children, vb = "0 0 24 24" }) => (
  <svg viewBox={vb} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const Icons = {
  play: (
    <I>
      <path d="M7 5.5v13l11-6.5-11-6.5Z" fill="currentColor" stroke="none" />
    </I>
  ),
  stop: (
    <I>
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
    </I>
  ),
  gear: (
    <I>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.5-2.4.9a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.4a7.6 7.6 0 0 0-2.6 1.5L4.6 5.5l-2 3.5 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.5 2.4-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.6-1.5l2.4.9 2-3.5-2-1.5Z" />
    </I>
  ),
  trash: (
    <I>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
    </I>
  ),
  plus: (
    <I>
      <path d="M12 5v14M5 12h14" />
    </I>
  ),
  importIcon: (
    <I>
      <path d="M12 3v10m0 0 4-4m-4 4-4-4" />
      <path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" />
    </I>
  ),
  power: (
    <I>
      <path d="M12 3v9" />
      <path d="M17.5 6.5a8 8 0 1 1-11 0" />
    </I>
  ),
  grid: (
    <I>
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
    </I>
  ),
  user: (
    <I>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" />
    </I>
  ),
  plug: (
    <I>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" />
      <path d="M12 17v4" />
    </I>
  ),
  list: (
    <I>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </I>
  ),
  moon: (
    <I>
      <path d="M20 13.2A7.5 7.5 0 1 1 10.8 4a6 6 0 0 0 9.2 9.2Z" />
    </I>
  ),
  sun: (
    <I>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </I>
  ),
};

/* ---------- 状态徽标 ---------- */

const STATUS_MAP = {
  online: { label: "在线钓鱼", cls: "green pulse" },
  starting: { label: "启动中", cls: "amber pulse" },
  reconnecting: { label: "重连中", cls: "amber pulse" },
  error: { label: "异常", cls: "red" },
  expired: { label: "会话失效", cls: "red" },
  stopped: { label: "已停止", cls: "gray" },
};

export function StatusChip({ status }) {
  const s = STATUS_MAP[status] || STATUS_MAP.stopped;
  return (
    <span className={`chip ${s.cls}`}>
      <span className="chip-dot" />
      {s.label}
    </span>
  );
}

/* ---------- 开关 ---------- */

export function Toggle({ on, onChange, disabled }) {
  return <button type="button" aria-pressed={on} disabled={disabled} className={"toggle" + (on ? " on" : "")} onClick={() => onChange(!on)} />;
}

/* ---------- 分段控件 ---------- */

export function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} type="button" className={value === o.value ? "active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- 模态 ---------- */

export function Modal({ title, desc, onClose, children, width, headExtra }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head">
          {title && <h3 className="modal-title">{title}</h3>}
          {desc && <p className="modal-desc">{desc}</p>}
          {headExtra}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ---------- 统计卡 ---------- */

export function StatCard({ label, value, sub }) {
  return (
    <div className="card stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/* ---------- 配置表单（由插件 configSchema 驱动） ---------- */

export function ConfigForm({ schema, config, onChange }) {
  if (!schema?.length) return <div className="field-hint">此插件没有可配置项。</div>;
  return (
    <div>
      {schema.map((f) => {
        const value = config?.[f.key] ?? f.default;
        if (f.type === "boolean") {
          return (
            <div className="toggle-row" key={f.key}>
              <div>
                <div className="t-label">{f.label}</div>
                {f.hint && <div className="t-desc">{f.hint}</div>}
              </div>
              <Toggle on={Boolean(value)} onChange={(v) => onChange({ ...config, [f.key]: v })} />
            </div>
          );
        }
        return (
          <div className="field" key={f.key} style={{ marginBottom: 12 }}>
            <label className="field-label">{f.label}</label>
            {f.type === "select" ? (
              <select className="select" value={value ?? ""} onChange={(e) => onChange({ ...config, [f.key]: e.target.value })}>
                {(f.options || []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                type={f.type === "number" ? "number" : "text"}
                value={value ?? ""}
                min={f.min}
                max={f.max}
                step={f.step}
                placeholder={f.placeholder}
                onChange={(e) => onChange({ ...config, [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value })}
              />
            )}
            {f.hint && <div className="field-hint">{f.hint}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- 主题化确认弹窗（替代浏览器原生 confirm） ---------- */

let confirmListener = null;

/** confirmDialog({ title, message, confirmLabel, danger }) -> Promise<boolean> */
export function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    if (!confirmListener) {
      // 兜底：宿主未挂载时退回原生 confirm
      resolve(window.confirm(opts.message || "确认执行？"));
      return;
    }
    confirmListener({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    confirmListener = setDialog;
    return () => {
      confirmListener = null;
    };
  }, []);
  if (!dialog) return null;
  const done = (v) => {
    dialog.resolve(v);
    setDialog(null);
  };
  return (
    <div className="overlay" style={{ zIndex: 60 }} onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="modal" style={{ width: "min(400px, 100%)", animation: "popIn .18s ease" }}>
        <div className="modal-head" style={{ paddingBottom: 6 }}>
          <h3 className="modal-title" style={{ fontSize: 16 }}>{dialog.title || "确认操作"}</h3>
        </div>
        <div className="modal-body" style={{ paddingTop: 0 }}>
          <p style={{ margin: "0 0 4px", color: "var(--text-2)", fontSize: 13.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {dialog.message}
          </p>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => done(false)}>取消</button>
            <button className={"btn " + (dialog.danger ? "danger" : "primary")} onClick={() => done(true)}>
              {dialog.confirmLabel || "确定"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- 行内 KV ---------- */

export function KV({ k, v }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

/* ---------- 数字 / 时间格式化 ---------- */

export function fmtNum(n) {
  if (n == null || isNaN(n)) return "–";
  return Number(n).toLocaleString("zh-CN");
}

export function fmtTime(ts) {
  if (!ts) return "–";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/* ---------- 轻提示 ---------- */

export function useToast() {
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast]);
  const node = toast ? (
    <div
      style={{
        position: "fixed",
        bottom: 28,
        left: "50%",
        transform: "translateX(-50%)",
        background: "var(--toast-bg, rgba(28, 30, 36, 0.92))",
        backdropFilter: "blur(10px)",
        color: "#fff",
        padding: "11px 20px",
        borderRadius: 14,
        fontSize: 13,
        maxWidth: "min(560px, 90vw)",
        boxShadow: "0 10px 40px rgba(0,0,0,.28)",
        zIndex: 99,
        animation: "popIn .2s ease",
      }}
    >
      {toast}
    </div>
  ) : null;
  return [setToast, node];
}
