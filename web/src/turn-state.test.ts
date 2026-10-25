import { describe, expect, it } from "vitest";
import {
  applyACPActivity,
  applyServerStatus,
  finishTurn,
  initialTurnStatus,
  markACPReady,
  markSessionCreated,
  markSessionCreateStarted,
  markWebSocketStarted,
  startPromptStatus,
} from "./turn-state";

describe("turn status timing", () => {
  it("tracks server lifecycle durations and first reply timing", () => {
    let state = initialTurnStatus(100);
    state = applyServerStatus(state, {
      phase: "connecting",
      label: "已连接服务器",
    }, 100);
    state = applyServerStatus(state, {
      phase: "sandbox_claiming",
      label: "领取沙箱",
      sandboxSource: "warm_pool",
    }, 120);
    state = applyServerStatus(state, {
      phase: "sandbox_waiting",
      label: "等待沙箱就绪",
    }, 220);
    state = applyServerStatus(state, {
      phase: "agent_connecting",
      label: "连接 Agent",
    }, 320);
    state = applyServerStatus(state, {
      phase: "agent_ready",
      label: "Agent 已连接",
    }, 370);
    state = applyACPActivity(state, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考" } }, 400);
    state = applyACPActivity(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "答案" } }, 600);
    const finished = finishTurn(state, 700);

    expect(finished.sandboxSource).toBe("warm_pool");
    expect(finished.websocketMs).toBe(20);
    expect(finished.sandboxMs).toBe(200);
    expect(finished.agentMs).toBe(50);
    expect(finished.firstReplyMs).toBe(300);
    expect(finished.thoughtMs).toBe(200);
    expect(finished.totalMs).toBe(600);
    expect(finished.phase).toBe("completed");
  });

  it("tracks ACP initialization separately from Agent Bridge connection", () => {
    let state = initialTurnStatus(0);
    state = applyServerStatus(state, { phase: "agent_ready", label: "Agent 已连接" }, 100);
    state = applyServerStatus(state, { phase: "acp_initializing", label: "正在初始化 ACP" }, 150);
    state = applyServerStatus(state, { phase: "acp_session_initializing", label: "正在创建 ACP session" }, 200);
    state = applyServerStatus(state, { phase: "acp_ready", label: "ACP session 已就绪" }, 250);

    expect(state.agentMs).toBeUndefined();
    expect(state.acpStartupMs).toBe(50);
    expect(state.acpInitializeMs).toBe(50);
    expect(state.acpSessionMs).toBe(50);
    expect(state.acpMs).toBe(150);
  });

  it("starts WebSocket timing when the browser begins opening the socket", () => {
    let state = initialTurnStatus(0);
    state = markWebSocketStarted(state, 100);
    state = applyServerStatus(state, { phase: "sandbox_claiming", label: "领取沙箱" }, 350);

    expect(state.websocketMs).toBe(250);
  });

  it("tracks new session creation separately from WebSocket timing", () => {
    let state = initialTurnStatus(0);
    state = markSessionCreateStarted(state, 100);
    state = markSessionCreated(state, 350);

    expect(state.sessionMs).toBe(250);
    expect(state.websocketMs).toBeUndefined();
  });

  it("starts first-token timing at send time after prewarming", () => {
    let state = initialTurnStatus(100);
    state = markWebSocketStarted(state, 120);
    state = applyServerStatus(state, { phase: "acp_ready", label: "ACP session 已就绪" }, 500);
    const sending = startPromptStatus(state, 1_000);

    expect(sending.startedAt).toBe(1_000);
    expect(sending.phase).toBe("acp_ready");
    expect(sending.websocketStartedAt).toBe(120);
    expect(sending.firstReplyMs).toBeUndefined();
    expect(applyACPActivity(sending, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "首 token" },
    }, 1_250).firstReplyMs).toBe(250);
  });

  it("finishes first-token timing when deep-thinking content arrives first", () => {
    const sending = startPromptStatus(initialTurnStatus(0), 1_000);

    const thinking = applyACPActivity(sending, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "先分析问题" },
    }, 1_450);

    expect(thinking.firstReplyMs).toBe(450);
    expect(thinking.thoughtStartedAt).toBe(1_450);
    expect(thinking.phase).toBe("thinking");
  });

  it("keeps a completed turn fixed when a late ACP update arrives", () => {
    let state = startPromptStatus(initialTurnStatus(0), 1_000);
    state = finishTurn(state, 1_500);

    const lateUpdate = applyACPActivity(state, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "晚到的通知" },
    }, 2_000);

    expect(lateUpdate.phase).toBe("completed");
    expect(lateUpdate.firstReplyMs).toBeUndefined();
    expect(lateUpdate.now).toBe(1_500);
  });

  it("tracks accumulated tool time and does not invent missing activity", () => {
    let state = initialTurnStatus(0);
    state = applyACPActivity(state, { sessionUpdate: "tool_call", toolCallId: "one", status: "in_progress" }, 10);
    state = applyACPActivity(state, { sessionUpdate: "tool_call_update", toolCallId: "one", status: "completed" }, 60);
    state = applyACPActivity(state, { sessionUpdate: "tool_call", toolCallId: "two", status: "in_progress" }, 100);
    state = applyACPActivity(state, { sessionUpdate: "tool_call_update", toolCallId: "two", status: "completed" }, 130);
    const finished = finishTurn(state, 200);

    expect(finished.toolMs).toBe(80);
    expect(finished.firstReplyMs).toBeUndefined();
    expect(finished.thoughtMs).toBeUndefined();
  });

  it("accumulates separate deep-thinking periods around tool work", () => {
    let state = initialTurnStatus(0);
    state = applyACPActivity(state, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先想" } }, 10);
    state = applyACPActivity(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一段" } }, 30);
    state = applyACPActivity(state, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "再想" } }, 50);
    state = applyACPActivity(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第二段" } }, 80);

    expect(finishTurn(state, 100).thoughtMs).toBe(50);
  });

  it("maps unknown phases to a generic processing state", () => {
    const state = applyServerStatus(initialTurnStatus(0), {
      phase: "future_phase",
      label: "未来阶段",
    }, 10);

    expect(state.phase).toBe("processing");
    expect(state.label).toBe("未来阶段");
  });
});
