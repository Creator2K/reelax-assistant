// 运行日志：实时流 + 过滤
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { fmtTime } from "../components/ui.jsx";

export default function Logs({ ctx }) {
  const { sessions, logs, logTick } = ctx;
  const [sessionId, setSessionId] = useState("");
  const [level, setLevel] = useState("debug");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const viewRef = useRef(null);
  const stickRef = useRef(true);

  // 服务端历史（首次进入补齐）
  useEffect(() => {
    api.logs({ sessionId: sessionId || undefined, level, limit: 400 }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    let list = logs;
    if (sessionId) list = list.filter((e) => e.sessionId === sessionId);
    if (level !== "debug") list = list.filter((e) => (e.level === "warn" || e.level === "error"));
    if (search) list = list.filter((e) => (e.tag + " " + e.msg).toLowerCase().includes(search.toLowerCase()));
    return list.slice(-600);
  }, [logs, logTick, sessionId, level, search]);

  useEffect(() => {
    const el = viewRef.current;
    if (el && stickRef.current && !paused) el.scrollTop = el.scrollHeight;
  }, [filtered.length]);

  const onScroll = () => {
    const el = viewRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">运行日志</h1>
        <p className="page-desc">引擎与插件的实时输出。保留最近 4000 条，重启服务后清空。</p>
      </div>

      <div className="log-toolbar">
        <select className="select" value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ width: 180 }}>
          <option value="">全部会话</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select className="select" value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: 130 }}>
          <option value="debug">全部级别</option>
          <option value="warn">警告及错误</option>
        </select>
        <input className="input" placeholder="搜索关键字…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
        <button className={"btn sm" + (paused ? " primary" : "")} onClick={() => setPaused((p) => !p)}>
          {paused ? "已暂停" : "滚动跟随"}
        </button>
        <span style={{ fontSize: 12, color: "var(--text-3)", marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
          {filtered.length} 条
        </span>
      </div>

      <div className="log-view" ref={viewRef} onScroll={onScroll}>
        {filtered.length === 0 ? (
          <div style={{ color: "var(--text-3)", textAlign: "center", paddingTop: 60 }}>暂无日志</div>
        ) : (
          filtered.map((e, i) => (
            <div key={i} className={"log-line " + e.level}>
              <span className="log-time">{fmtTime(e.t)}</span>
              <span className="log-tag">[{e.plugin || e.tag || "core"}]</span>
              <span>{e.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
