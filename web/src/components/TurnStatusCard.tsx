import { useState } from "react";
import type { TurnPhase, TurnStatusState } from "../turn-state";

interface TurnStatusCardProps { status: TurnStatusState; }

export function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined) return "未发生";
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

const phaseLabels: Record<TurnPhase, string> = {
  connecting: "正在建立 WebSocket 连接",
  sandbox_claiming: "正在领取沙箱",
  sandbox_waiting: "正在等待沙箱就绪",
  agent_connecting: "正在连接沙箱里的 Agent Bridge",
  agent_ready: "正在启动 ACP Agent",
  acp_initializing: "正在执行 ACP initialize",
  acp_session_initializing: "正在创建或恢复 ACP session",
  acp_ready: "ACP 会话已就绪",
  thinking: "Agent 正在深度思考",
  tool_calling: "正在调用工具",
  responding: "正在生成回复",
  completed: "本轮已完成",
  failed: "本轮连接失败",
  processing: "正在处理请求",
};

const explanations = {
  session: "从点击发送，到 tinyAgent 后端的 POST /api/sessions 返回新的 session ID。已有会话再次发送时不会重复创建。",
  websocket: "从浏览器开始建立 WebSocket，到 tinyAgent 后端完成 WebSocket 升级并确认连接。包含网络、TLS 和 WebSocket 握手时间。",
  sandbox: "从后端创建或领取 SandboxClaim，到 ACK 返回可用沙箱 IP。这里会显示本轮使用的是预热池沙箱还是额外创建的沙箱。",
  agent: "从拿到沙箱 IP，到 tinyAgent 后端通过 WebSocket 连接沙箱里的 Agent Bridge 端口 8080。这个时间不包含模型思考。",
  acp: "从浏览器发送 ACP initialize 开始，到 Agent 返回初始化以及 session/new 或 session/load 结果。完成后才开始处理你的问题。",
  acpStartup: "从 Agent Bridge 连接成功，到浏览器发出 ACP initialize。这里主要观察沙箱里的 codex-acp 进程启动和首次响应准备。",
  acpInitialize: "从浏览器发出 ACP initialize，到 Agent 返回 initialize 响应。这里观察 ACP 协议初始化本身。",
  acpSession: "从 initialize 完成，到 Agent 返回 session/new 或 session/load。这里观察 ACP 会话创建或从 AgenticFS 恢复。",
  firstToken: "从点击发送开始，到浏览器收到第一段 AI 内容为止；深度思考内容和普通回复内容都会结束这项计时。它是发送、后端转发、模型生成首段内容以及返回浏览器的端到端耗时；预热沙箱只表示准备阶段已提前完成，并不等于纯模型耗时。",
};

export function TurnStatusCard({ status }: TurnStatusCardProps) {
  const [expanded, setExpanded] = useState(false);
  const now = status.now ?? (status.totalMs === undefined ? Date.now() : status.startedAt + status.totalMs);
  const sessionMs = status.sessionMs ?? (status.sessionStartedAt === undefined ? undefined : now - status.sessionStartedAt);
  const websocketMs = status.websocketMs ?? (status.websocketStartedAt === undefined ? undefined : now - status.websocketStartedAt);
  const sandboxMs = status.sandboxMs ?? (status.sandboxStartedAt === undefined ? undefined : now - status.sandboxStartedAt);
  const agentMs = status.agentMs ?? (status.agentStartedAt === undefined ? undefined : now - status.agentStartedAt);
  const acpStartupMs = status.acpStartupMs ?? (status.acpStartedAt === undefined ? undefined : status.acpInitializeStartedAt === undefined ? now - status.acpStartedAt : status.acpInitializeStartedAt - status.acpStartedAt);
  const acpInitializeMs = status.acpInitializeMs ?? (status.acpInitializeStartedAt === undefined ? undefined : status.acpSessionStartedAt === undefined ? now - status.acpInitializeStartedAt : status.acpSessionStartedAt - status.acpInitializeStartedAt);
  const acpSessionMs = status.acpSessionMs ?? (status.acpSessionStartedAt === undefined ? undefined : now - status.acpSessionStartedAt);
  const firstTokenMs = status.firstReplyMs ?? (status.promptStarted === false ? undefined : status.phase === "completed" || status.phase === "failed" ? undefined : now - status.startedAt);
  const sandboxLabel = status.sandboxSource === "provisioning" ? "新创建的沙箱" : "预热池沙箱";

  return (
    <section className="turn-status" aria-label="本轮执行状态">
      <div className="turn-status-header">
        <strong>{phaseLabels[status.phase] ?? status.label}</strong>
        <button
          className="turn-status-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起详情" : "展开详情"}
        </button>
      </div>
      <div className={status.promptStarted !== false && status.firstReplyMs === undefined && status.phase !== "completed" && status.phase !== "failed" ? "turn-status-total active" : "turn-status-total"}>
        <span className="turn-status-stage-label">
          {status.promptStarted !== false && status.firstReplyMs === undefined && status.phase !== "completed" && status.phase !== "failed" ? "正在计时：" : "✓ "}首 token 总耗时
          <span className="status-help" title={explanations.firstToken} aria-label={explanations.firstToken}>?</span>
        </span>
        <strong>{formatDuration(firstTokenMs)}</strong>
      </div>
      {expanded && (
        <div className="turn-status-stages" aria-label="连接准备进度">
          <Stage label={status.sessionStartedAt === undefined ? "会话已存在" : "创建会话"} value={status.sessionStartedAt === undefined ? "已复用" : formatDuration(sessionMs)} help={explanations.session} active={status.sessionStartedAt !== undefined && sessionMs === undefined} />
          <Stage label="WebSocket 握手" value={formatDuration(websocketMs)} help={explanations.websocket} active={status.websocketStartedAt !== undefined && websocketMs === undefined} />
          <Stage label={`${sandboxLabel}就绪`} value={formatDuration(sandboxMs)} help={explanations.sandbox} active={status.phase === "sandbox_claiming" || status.phase === "sandbox_waiting"} />
          <Stage label="Agent Bridge 连接" value={formatDuration(agentMs)} help={explanations.agent} active={status.phase === "agent_connecting"} />
          <Stage label="ACP Agent 启动" value={formatDuration(acpStartupMs)} help={explanations.acpStartup} active={status.phase === "agent_ready"} />
          <Stage label="ACP initialize" value={formatDuration(acpInitializeMs)} help={explanations.acpInitialize} active={status.phase === "acp_initializing"} />
          <Stage label="创建/恢复 ACP session" value={formatDuration(acpSessionMs)} help={explanations.acpSession} active={status.phase === "acp_session_initializing"} />
        </div>
      )}
    </section>
  );
}

function Stage({ label, value, help, active }: { label: string; value: string; help: string; active: boolean }) {
  return (
    <div className={active ? "turn-status-stage active" : "turn-status-stage"}>
      <span className="turn-status-stage-label">
        {active ? "正在进行：" : "✓ "}{label}
        <span className="status-help" title={help} aria-label={help}>?</span>
      </span>
      <strong>{value}</strong>
    </div>
  );
}
