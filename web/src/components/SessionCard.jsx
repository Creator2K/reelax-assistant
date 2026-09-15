// 会话卡片：compact（总览，清爽无详情）/ full（会话管理，可点开设置，图标操作）
import React from "react";
import { api } from "../api.js";
import { StatusChip, Icons, confirmDialog, fmtNum, fmtTime } from "./ui.jsx";

export default function SessionCard({ session, variant = "full", onOpen, onChanged, onError }) {
  const run = session.run;
  const total = run?.totalCasts || 0;
  const used = total ? total - (run?.remainingCasts ?? 0) : 0;
  const pct = total ? Math.round((used / total) * 100) : 0;
  const st = session.stats;
  const last = session.lastSettlement;
  const running = session.status !== "stopped";

  const act = async (fn, label) => {
    try {
      await fn();
      await onChanged?.();
    } catch (err) {
      onError?.(`${label}失败：${err.message}`);
    }
  };

  const openSettings = (e) => {
    e?.stopPropagation();
    onOpen?.(session);
  };

  return (
    <div
      className={"card session-card" + (variant === "full" ? " clickable" : "")}
      onClick={variant === "full" ? () => onOpen?.(session) : undefined}
    >
      <div className="session-head">
        <div>
          <div className="session-name">{session.label}</div>
          <div className="session-meta">
            {session.player ? `${session.player.nickname || "未命名"} · Lv.${session.player.level ?? "?"}` : session.email || "未登录"}
          </div>
        </div>
        <StatusChip status={session.status} />
      </div>

      {run && total > 0 && (
        <div>
          <div className="row between" style={{ marginBottom: 5 }}>
            <span className="session-meta">本轮进度</span>
            <span className="session-meta">
              {used}/{total} 杆
            </span>
          </div>
          <div className="progress">
            <div className="progress-bar" style={{ width: pct + "%" }} />
          </div>
        </div>
      )}

      <div className="session-stats">
        <div className="session-stat">
          <div className="k">累计金币</div>
          <div className="v">{fmtNum(st?.gold)}</div>
        </div>
        <div className="session-stat">
          <div className="k">累计渔获</div>
          <div className="v">{fmtNum(st?.fishCount)}</div>
        </div>
        <div className="session-stat">
          <div className="k">最近同步</div>
          <div className="v" style={{ fontSize: 12.5 }}>{fmtTime(session.lastSyncAt)}</div>
        </div>
      </div>

      {last && (
        <div className="session-meta">
          最近一杆：金币 +{fmtNum(last.directGoldNet ?? 0)} · 经验 +{fmtNum(last.experience ?? 0)}
          {last.mode && last.mode !== "online" ? ` · ${last.mode}模式` : ""}
        </div>
      )}

      {session.lastError && session.status !== "online" && (
        <div className="session-meta" style={{ color: "var(--red-text)" }}>{session.lastError}</div>
      )}

      <div className="session-actions" onClick={(e) => e.stopPropagation()}>
        {variant === "full" ? (
          <>
            <button
              className={"icon-btn" + (running ? " stop" : " primary")}
              title={running ? "停止引擎" : "启动引擎"}
              onClick={() => act(() => (running ? api.stopSession(session.id) : api.startSession(session.id)), running ? "停止" : "启动")}
            >
              {running ? Icons.stop : Icons.play}
            </button>
            <button className="icon-btn" title="会话设置" onClick={openSettings}>
              {Icons.gear}
            </button>
            <button
              className="icon-btn danger"
              title="删除会话"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: "删除会话",
                  message: `确定删除会话「${session.label}」？\n引擎将停止，配置将被移除，此操作不可撤销。`,
                  confirmLabel: "删除",
                  danger: true,
                });
                if (ok) act(() => api.deleteSession(session.id), "删除");
              }}
            >
              {Icons.trash}
            </button>
            <div style={{ flex: 1 }} />
            <span className="session-meta">{running ? "引擎运行中" : "引擎已停止"}</span>
          </>
        ) : (
          <>
            <button
              className={"btn sm " + (running ? "" : "primary")}
              onClick={() => act(() => (running ? api.stopSession(session.id) : api.startSession(session.id)), running ? "停止" : "启动")}
            >
              {running ? "停止引擎" : "启动引擎"}
            </button>
            <div style={{ flex: 1 }} />
          </>
        )}
      </div>
    </div>
  );
}
