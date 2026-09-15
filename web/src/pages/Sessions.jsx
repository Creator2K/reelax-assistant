// 会话管理：卡片（图标操作 + 点开设置）+ 分页式会话弹窗（概览 / 插件 / 设置）
import React, { useState } from "react";
import { api } from "../api.js";
import SessionCard from "../components/SessionCard.jsx";
import { KV, Modal, Toggle, ConfigForm, Segmented, Icons, confirmDialog, fmtNum, useToast } from "../components/ui.jsx";

export default function Sessions({ ctx }) {
  const { sessions, plugins, refresh } = ctx;
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [toast, toastNode] = useToast();

  const detail = sessions.find((s) => s.id === detailId);

  return (
    <div className="page">
      <div className="page-header row between">
        <div>
          <h1 className="page-title">会话管理</h1>
          <p className="page-desc">每个会话对应一个游戏账号。点开卡片管理引擎与插件；支持账号密码（可自动重登）或 Cookie。</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          {Icons.plus} 添加会话
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="card empty">
          <div className="empty-title">还没有会话</div>
          <div>点击右上角「添加会话」开始使用。</div>
        </div>
      ) : (
        <div className="session-grid">
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} variant="full" onOpen={(x) => setDetailId(x.id)} onChanged={refresh} onError={(m) => toast(m)} />
          ))}
        </div>
      )}

      {adding && <AddSessionModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} onError={toast} />}
      {detail && (
        <SessionDetailModal
          session={detail}
          plugins={plugins}
          onClose={() => setDetailId(null)}
          onChanged={refresh}
          onError={toast}
          onDeleted={() => {
            setDetailId(null);
            refresh();
          }}
        />
      )}
      {toastNode}
    </div>
  );
}

/* ---------- 添加会话 ---------- */

function AddSessionModal({ onClose, onDone, onError }) {
  const [tab, setTab] = useState("credentials");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [cookie, setCookie] = useState("");
  const [autoStart, setAutoStart] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.createSession({
        label,
        authType: tab,
        email: tab === "credentials" ? email : undefined,
        password: tab === "credentials" ? password : undefined,
        cookie: tab === "cookie" ? cookie.trim() : undefined,
        autoStart,
      });
      onDone();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="添加会话" desc="账号密码方式在凭证失效时可自动重登；Cookie 方式不在服务端保存密码。" onClose={onClose}>
      <div style={{ marginBottom: 18 }}>
        <Segmented
          options={[
            { value: "credentials", label: "账号密码" },
            { value: "cookie", label: "Cookie 导入" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      <div className="field">
        <label className="field-label">备注名称（可选）</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={tab === "credentials" ? "默认使用邮箱" : "例如：大号"} />
      </div>

      {tab === "credentials" ? (
        <>
          <div className="field">
            <label className="field-label">邮箱</label>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="field">
            <label className="field-label">密码</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="游戏登录密码" />
            <div className="field-hint">密码明文保存在服务端 data/config.json，请确保部署环境安全。</div>
          </div>
        </>
      ) : (
        <div className="field">
          <label className="field-label">Cookie</label>
          <textarea
            className="textarea"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder={"在游戏页面 DevTools → Network → 任意请求 → Request Headers 中复制完整 Cookie，例如：\narcane_session=xxxx"}
          />
          <div className="field-hint">Cookie 失效后需要重新导入（无法自动重登）。</div>
        </div>
      )}

      <div className="toggle-row" style={{ borderTop: "1px solid var(--border)" }}>
        <div>
          <div className="t-label">服务启动时自动运行</div>
          <div className="t-desc">重启后自动恢复该会话的引擎</div>
        </div>
        <Toggle on={autoStart} onChange={setAutoStart} />
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy || (tab === "credentials" ? !email || !password : !cookie.trim())} onClick={submit}>
          {busy ? "验证中…" : "创建并验证"}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- 会话详情（分页式） ---------- */

function SessionDetailModal({ session, plugins, onClose, onChanged, onError, onDeleted }) {
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null);
  const [label, setLabel] = useState(session.label);
  const [email, setEmail] = useState(session.email || "");
  const [password, setPassword] = useState("");
  const [cookie, setCookie] = useState("");

  const fetchLive = async () => {
    try {
      setLive(await api.sessionState(session.id));
    } catch (err) {
      onError(`读取实时状态失败：${err.message}`);
    }
  };

  const togglePlugin = async (pluginId, enabled) => {
    try {
      const r = await api.setSessionPlugin(session.id, pluginId, { enabled });
      if (enabled && r && r.ok === false) {
        onError(`「${pluginId}」启动失败：${r.error || "未知原因"}`);
      }
      await onChanged();
    } catch (err) {
      onError(err.message);
      await onChanged();
    }
  };

  const saveConfig = async (pluginId, config) => {
    try {
      await api.setSessionPlugin(session.id, pluginId, { config });
      await onChanged();
    } catch (err) {
      onError(err.message);
    }
  };

  const saveSettings = async () => {
    setBusy(true);
    try {
      const patch = { label };
      if (session.hasCredentials && email) patch.email = email;
      if (password) patch.password = password;
      if (!session.hasCredentials && cookie.trim()) patch.cookie = cookie.trim();
      await api.updateSession(session.id, patch);
      setPassword("");
      setCookie("");
      onError("已保存 ✓");
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: "删除会话",
      message: `确定删除会话「${session.label}」？\n引擎将停止，配置将被移除，此操作不可撤销。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteSession(session.id);
      onDeleted?.();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const run = live?.run || session.run;
  const running = session.status !== "stopped";

  return (
    <Modal
      title={session.label}
      desc={`${session.hasCredentials ? session.email : "Cookie 会话"}${session.publicId ? ` · UID ${session.publicId}` : ""}`}
      onClose={onClose}
      width={600}
      headExtra={
        <div style={{ marginTop: 14 }}>
          <Segmented
            options={[
              { value: "overview", label: "概览" },
              { value: "plugins", label: "插件" },
              { value: "settings", label: "设置" },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      }
    >
      {tab === "overview" && (
        <div>
          <div className="row between" style={{ margin: "4px 0 14px" }}>
            <span className="session-meta">数据每 2 秒自动刷新</span>
            <div className="row">
              <button className="btn sm" onClick={fetchLive}>读取实时状态</button>
              <button
                className={"btn sm " + (running ? "" : "primary")}
                onClick={async () => {
                  try {
                    await (running ? api.stopSession(session.id) : api.startSession(session.id));
                    await onChanged();
                  } catch (err) {
                    onError(err.message);
                  }
                }}
              >
                {running ? "停止引擎" : "启动引擎"}
              </button>
            </div>
          </div>
          <KV k="运行状态" v={run ? { running: "钓鱼中", stopped: "已停止", completed: "已完成" }[run.status] || run.status : "–"} />
          <KV k="模式" v={run?.mode === "online" ? "在线" : run?.mode || "–"} />
          <KV k="剩余杆数" v={run ? `${run.remainingCasts ?? "?"} / ${run.totalCasts ?? "?"}` : "–"} />
          <KV k="结算周期" v={run ? `${Math.round((run.cycleDurationMs || 0) / 1000)} 秒/杆` : "–"} />
          {session.player && (
            <>
              <KV k="等级" v={`Lv.${session.player.level ?? "?"}`} />
              <KV k="金币" v={fmtNum(session.player.gold)} />
              <KV k="遗物" v={fmtNum(session.player.relics)} />
              {session.player.fragments != null && <KV k="奥秘碎片" v={fmtNum(session.player.fragments)} />}
            </>
          )}
          {session.proofExpiresAt && <KV k="签名密钥有效期" v={new Date(session.proofExpiresAt).toLocaleTimeString("zh-CN")} />}
          {session.lastError && <KV k="最近错误" v={session.lastError} />}
        </div>
      )}

      {tab === "plugins" && (
        <div>
          {plugins.map((p) => {
            const state = session.plugins?.[p.id] || { enabled: p.defaultEnabled, config: p.defaultConfig };
            return (
              <div key={p.id} className="plugin-section" style={{ paddingTop: 4 }}>
                <div className="toggle-row">
                  <div>
                    <div className="t-label">
                      {p.name}
                      {state.running && <span className="chip accent" style={{ marginLeft: 8, padding: "1px 8px", fontSize: 10.5 }}>运行中</span>}
                      {!state.running && state.enabled && state.startError && (
                        <span className="chip red" style={{ marginLeft: 8, padding: "1px 8px", fontSize: 10.5 }}>启动失败</span>
                      )}
                    </div>
                    <div className="t-desc">{p.description}</div>
                    {!state.running && state.enabled && state.startError && (
                      <div className="t-desc" style={{ color: "var(--red-text)" }}>{state.startError}</div>
                    )}
                  </div>
                  <Toggle on={state.enabled} onChange={(v) => togglePlugin(p.id, v)} />
                </div>
                {p.configSchema?.length > 0 && state.enabled && (
                  <div style={{ padding: "2px 0 12px" }}>
                    <ConfigForm schema={p.configSchema} config={state.config} onChange={(c) => saveConfig(p.id, c)} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "settings" && (
        <div>
          <div className="field">
            <label className="field-label">备注名称</label>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>

          {session.hasCredentials ? (
            <>
              <div className="field">
                <label className="field-label">邮箱</label>
                <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">新密码（留空保持不变）</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="不修改请留空" />
              </div>
            </>
          ) : (
            <div className="field">
              <label className="field-label">Cookie（重新导入）</label>
              <textarea className="textarea" value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="粘贴新的 arcane_session=..." />
            </div>
          )}

          <div className="toggle-row" style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", marginBottom: 18 }}>
            <div>
              <div className="t-label">服务启动时自动运行</div>
              <div className="t-desc">重启后自动恢复该会话的引擎</div>
            </div>
            <Toggle
              on={session.autoStart}
              onChange={async (v) => {
                try {
                  await api.updateSession(session.id, { autoStart: v });
                  await onChanged();
                } catch (err) {
                  onError(err.message);
                }
              }}
            />
          </div>

          <div className="row between">
            <button className="btn danger" disabled={busy} onClick={remove}>
              {Icons.trash} 删除会话
            </button>
            <div className="row">
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.loginSession(session.id);
                    onError("凭证验证通过 ✓");
                  } catch (err) {
                    onError(`验证失败：${err.message}`);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                验证凭证
              </button>
              <button className="btn primary" disabled={busy} onClick={saveSettings}>
                保存修改
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
