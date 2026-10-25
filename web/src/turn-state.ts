import type { ACPUpdate, TurnStatusEvent } from "./types";

export type TurnPhase =
  | "connecting"
  | "sandbox_claiming"
  | "sandbox_waiting"
  | "agent_connecting"
  | "agent_ready"
  | "acp_initializing"
  | "acp_session_initializing"
  | "acp_ready"
  | "thinking"
  | "tool_calling"
  | "responding"
  | "completed"
  | "failed"
  | "processing";

export interface TurnStatusState {
  phase: TurnPhase;
  label: string;
  sandboxSource?: TurnStatusEvent["sandboxSource"];
  startedAt: number;
  phaseStartedAt: number;
  websocketMs?: number;
  sessionMs?: number;
  sandboxMs?: number;
  agentMs?: number;
  acpMs?: number;
  acpStartupMs?: number;
  acpInitializeMs?: number;
  acpSessionMs?: number;
  firstReplyMs?: number;
  promptStarted?: boolean;
  thoughtMs?: number;
  toolMs?: number;
  totalMs?: number;
  now?: number;
  thoughtStartedAt?: number;
  sandboxStartedAt?: number;
  agentStartedAt?: number;
  acpStartedAt?: number;
  acpInitializeStartedAt?: number;
  acpSessionStartedAt?: number;
  websocketStartedAt?: number;
  sessionStartedAt?: number;
  toolStarts: Record<string, number>;
}

const knownPhases = new Set<TurnPhase>([
  "connecting",
  "sandbox_claiming",
  "sandbox_waiting",
  "agent_connecting",
  "agent_ready",
  "acp_initializing",
  "acp_session_initializing",
  "acp_ready",
  "thinking",
  "tool_calling",
  "responding",
  "completed",
  "failed",
]);

export function initialTurnStatus(now = Date.now()): TurnStatusState {
  return {
    phase: "connecting",
    label: "连接中",
    startedAt: now,
    phaseStartedAt: now,
    now,
    promptStarted: false,
    toolStarts: {},
  };
}

export function applyServerStatus(
  state: TurnStatusState,
  event: TurnStatusEvent,
  now: number,
): TurnStatusState {
  const phase = knownPhases.has(event.phase as TurnPhase)
    ? (event.phase as TurnPhase)
    : "processing";
  const next = { ...state, phase, label: event.label, phaseStartedAt: now };
  next.now = now;
  if (event.sandboxSource) next.sandboxSource = event.sandboxSource;
  if (phase === "sandbox_claiming" && next.sandboxStartedAt === undefined)
    next.sandboxStartedAt = now;
  if (phase === "sandbox_claiming" && next.websocketMs === undefined)
    next.websocketMs = now - (next.websocketStartedAt ?? state.startedAt);
  if (phase === "agent_connecting") {
    next.sandboxMs ??= next.sandboxStartedAt === undefined ? undefined : now - next.sandboxStartedAt;
    next.agentStartedAt = now;
  }
  if (phase === "agent_ready" && next.agentStartedAt !== undefined)
    next.agentMs = now - next.agentStartedAt;
  if (phase === "agent_ready") next.acpStartedAt ??= now;
  if (phase === "acp_initializing") {
    if (next.acpStartedAt !== undefined && next.acpStartupMs === undefined)
      next.acpStartupMs = now - next.acpStartedAt;
    next.acpInitializeStartedAt = now;
  }
  if (phase === "acp_session_initializing") {
    if (next.acpInitializeStartedAt !== undefined && next.acpInitializeMs === undefined)
      next.acpInitializeMs = now - next.acpInitializeStartedAt;
    next.acpSessionStartedAt ??= now;
  }
  if (phase === "acp_ready") {
    if (next.acpSessionStartedAt !== undefined && next.acpSessionMs === undefined)
      next.acpSessionMs = now - next.acpSessionStartedAt;
    if (next.acpStartedAt !== undefined && next.acpMs === undefined)
      next.acpMs = now - next.acpStartedAt;
  }
  return next;
}

export function markWebSocketStarted(state: TurnStatusState, now: number): TurnStatusState {
  return { ...state, websocketStartedAt: now, now };
}

export function markSessionCreateStarted(state: TurnStatusState, now: number): TurnStatusState {
  return { ...state, sessionStartedAt: now, now };
}

export function markSessionCreated(state: TurnStatusState, now: number): TurnStatusState {
  const next = { ...state, now };
  if (next.sessionStartedAt !== undefined && next.sessionMs === undefined)
    next.sessionMs = now - next.sessionStartedAt;
  return next;
}

export function markACPReady(state: TurnStatusState, now: number): TurnStatusState {
  const next = { ...state, now };
  if (next.acpStartedAt !== undefined && next.acpMs === undefined)
    next.acpMs = now - next.acpStartedAt;
  return next;
}

export function startPromptStatus(state: TurnStatusState, now: number): TurnStatusState {
  return {
    ...state,
    startedAt: now,
    phaseStartedAt: now,
    firstReplyMs: undefined,
    promptStarted: true,
    thoughtMs: undefined,
    toolMs: undefined,
    totalMs: undefined,
    thoughtStartedAt: undefined,
    toolStarts: {},
    now,
    phase: "acp_ready",
    label: "Agent 已预热，直接发送",
  };
}

export function applyACPActivity(
  state: TurnStatusState,
  update: ACPUpdate,
  now: number,
): TurnStatusState {
  // ACP 通知可能在 prompt 请求已返回后才到达；已完成回合必须保持快照，
  // 否则晚到的消息会把首 token 计时重新打开，并污染下一次发送的显示。
  if (state.phase === "completed" || state.phase === "failed") return state;
  const next = { ...state, toolStarts: { ...state.toolStarts } };
  next.now = now;
  if (update.sessionUpdate === "agent_thought_chunk") {
    if (next.firstReplyMs === undefined) next.firstReplyMs = now - next.startedAt;
    next.thoughtStartedAt ??= now;
    next.phase = "thinking";
    next.label = "深度思考";
    next.phaseStartedAt = now;
    return next;
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    closeThought(next, now);
    if (update.toolCallId && update.sessionUpdate === "tool_call" && update.status !== "completed")
      next.toolStarts[update.toolCallId] ??= now;
    if (update.toolCallId && update.status === "completed" && next.toolStarts[update.toolCallId] !== undefined) {
      next.toolMs = (next.toolMs ?? 0) + now - next.toolStarts[update.toolCallId];
      delete next.toolStarts[update.toolCallId];
    }
    next.phase = "tool_calling";
    next.label = "工具调用";
    next.phaseStartedAt = now;
    return next;
  }
  if (update.sessionUpdate === "agent_message_chunk") {
    if (next.firstReplyMs === undefined) next.firstReplyMs = now - next.startedAt;
    closeThought(next, now);
    next.phase = "responding";
    next.label = "生成回复";
    next.phaseStartedAt = now;
  }
  return next;
}

export function finishTurn(state: TurnStatusState, now: number): TurnStatusState {
  const next = { ...state, phase: "completed" as const, label: "已完成", totalMs: now - state.startedAt, now };
  closeThought(next, now);
  for (const startedAt of Object.values(next.toolStarts))
    next.toolMs = (next.toolMs ?? 0) + now - startedAt;
  next.toolStarts = {};
  return next;
}

function closeThought(state: TurnStatusState, now: number): void {
  if (state.thoughtStartedAt === undefined) return;
  state.thoughtMs = (state.thoughtMs ?? 0) + now - state.thoughtStartedAt;
  state.thoughtStartedAt = undefined;
}

export function failTurn(state: TurnStatusState, now: number): TurnStatusState {
  return { ...finishTurn(state, now), phase: "failed", label: "无法连接 Agent" };
}

export function tickTurnStatus(state: TurnStatusState, now: number): TurnStatusState {
  return { ...state, now };
}
