// 总览页：核心指标 + 紧凑会话卡片（无详情按钮，管理请前往会话管理）
import React from "react";
import SessionCard from "../components/SessionCard.jsx";
import { StatCard, fmtNum, useToast } from "../components/ui.jsx";

export default function Dashboard({ ctx }) {
  const { sessions, status } = ctx;
  const [toast, toastNode] = useToast();
  const online = sessions.filter((s) => s.status === "online").length;
  const running = sessions.filter((s) => s.status !== "stopped").length;
  const gold = sessions.reduce((a, s) => a + (s.stats?.gold || 0), 0);
  const fish = sessions.reduce((a, s) => a + (s.stats?.fishCount || 0), 0);
  const casts = sessions.reduce((a, s) => a + (s.stats?.castsResolved || 0), 0);

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">总览</h1>
        <p className="page-desc">
          引擎按服务器节拍自动维持在线钓鱼；连接 {status?.baseUrl || "…"}
          {status ? ` · 当前游戏在线 ${fmtNum(status.online)} 人` : ""}
        </p>
      </div>

      <div className="stat-grid">
        <StatCard label="在线会话" value={`${online} / ${sessions.length || 0}`} sub={`${running} 个引擎运行中`} />
        <StatCard label="累计结算杆数" value={fmtNum(casts)} sub="引擎启动以来" />
        <StatCard label="累计金币收益" value={fmtNum(gold)} sub="税后净金币" />
        <StatCard label="累计渔获" value={fmtNum(fish)} sub="鱼条数" />
      </div>

      <div className="section-title">会话</div>
      {sessions.length === 0 ? (
        <div className="card empty">
          <div className="empty-title">还没有会话</div>
          <div>
            前往 <a href="#/sessions" style={{ color: "var(--accent)" }}>会话管理</a> 添加游戏账号，引擎会自动保持其在线钓鱼。
          </div>
        </div>
      ) : (
        <div className="session-grid">
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} variant="compact" onChanged={ctx.refresh} onError={(m) => toast(m)} />
          ))}
        </div>
      )}
      {toastNode}
    </div>
  );
}
