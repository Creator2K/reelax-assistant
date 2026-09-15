// 插件中心：浏览能力单元、导入外部插件、卸载外部插件
// 所有插件默认关闭；在「会话详情 → 插件」中按会话启用。
import React, { useState } from "react";
import { api } from "../api.js";
import { Badge } from "../components/badge.jsx";
import { ConfigForm, Modal, Icons, confirmDialog, useToast } from "../components/ui.jsx";

export default function Plugins({ ctx }) {
  const { plugins, sessions, refresh } = ctx;
  const [expanded, setExpanded] = useState({});
  const [drafts, setDrafts] = useState({});
  const [importing, setImporting] = useState(false);
  const [toast, toastNode] = useToast();

  const saveDefault = async (pluginId, config) => {
    try {
      await api.setPluginDefault(pluginId, { config });
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  };

  const unload = async (p) => {
    const ok = await confirmDialog({
      title: "卸载插件",
      message: `确定卸载外部插件「${p.name}」？\n文件将从 data/plugins 删除，所有会话中的实例会立即停止。`,
      confirmLabel: "卸载",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.unloadPlugin(p.id);
      toast(`已卸载「${p.name}」`);
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header row between">
        <div>
          <h1 className="page-title">插件中心</h1>
          <p className="page-desc">插件默认全部关闭。在「会话详情 → 插件」中按会话启用与配置；这里可导入自己的插件或查看默认配置。</p>
        </div>
        <button className="btn primary" onClick={() => setImporting(true)}>
          {Icons.importIcon} 导入插件
        </button>
      </div>

      {plugins.length === 0 ? (
        <div className="card empty">
          <div className="empty-title">没有已加载的插件</div>
          <div>把插件文件放入 server/data/plugins，或点击右上角「导入插件」。</div>
        </div>
      ) : (
        <div className="plugin-grid">
          {plugins.map((p) => {
            const enabledCount = sessions.filter((s) => s.plugins?.[p.id]?.enabled).length;
            const isExpanded = expanded[p.id];
            const draft = drafts[p.id] ?? p.defaultConfig ?? {};
            return (
              <div key={p.id} className="card plugin-card">
                <div className="plugin-head">
                  <div className="plugin-name">
                    {p.name}
                    <Badge builtin={p.builtin}>{p.builtin ? "内置" : "外部"}</Badge>
                    <span style={{ color: "var(--text-3)", fontWeight: 500, fontSize: 11.5 }}>v{p.version}</span>
                  </div>
                  {!p.builtin && (
                    <button className="icon-btn danger" title="卸载插件" onClick={() => unload(p)}>
                      {Icons.trash}
                    </button>
                  )}
                </div>
                <div className="plugin-desc">{p.description}</div>
                <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                  {enabledCount ? `${enabledCount} 个会话已启用` : "暂无会话启用"}
                </div>
                {p.configSchema?.length > 0 && (
                  <div>
                    <button className="btn sm ghost" style={{ color: "var(--text-2)", paddingLeft: 0 }} onClick={() => setExpanded((e) => ({ ...e, [p.id]: !e[p.id] }))}>
                      {isExpanded ? "收起默认配置 ▲" : "新会话默认配置 ▼"}
                    </button>
                    {isExpanded && (
                      <div style={{ paddingTop: 8 }}>
                        <ConfigForm schema={p.configSchema} config={draft} onChange={(c) => setDrafts((d) => ({ ...d, [p.id]: c }))} />
                        <button className="btn sm primary" onClick={() => saveDefault(p.id, draft)}>
                          保存默认配置
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => { setImporting(false); refresh(); }} onError={toast} />}
      {toastNode}
    </div>
  );
}

function ImportModal({ onClose, onDone, onError }) {
  const [filename, setFilename] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const p = await api.importPlugin({ code, filename: filename.trim() || undefined });
      onError(`已导入「${p.name}」（${p.id}），可在会话详情中启用`);
      onDone();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="导入插件"
      desc="粘贴插件代码（export default { id, name, ... }），校验通过后热加载，无需重启服务。"
      onClose={onClose}
      width={640}
    >
      <div className="field">
        <label className="field-label">文件名（可选）</label>
        <input className="input" value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="my-plugin.js" />
      </div>
      <div className="field">
        <label className="field-label">插件代码</label>
        <textarea
          className="textarea"
          style={{ minHeight: 220 }}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={`export default {\n  id: "my-plugin",\n  name: "我的插件",\n  async onStart(ctx) {\n    ctx.log.info("my-plugin", "hello");\n  },\n};`}
        />
        <div className="field-hint">开发指南见 docs/EXTENDING.md。导入的插件属于「外部插件」，可在插件中心卸载。</div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy || !code.trim()} onClick={submit}>
          {busy ? "校验中…" : "校验并导入"}
        </button>
      </div>
    </Modal>
  );
}
