import { describe, expect, it } from "vitest";
import {
  appendUserMessage,
  applyTimelineUpdate,
  applySessionUpdate,
  clearPersistedAgentMessage,
  completeTimeline,
  initialACPState,
} from "./acp-state";

// 这些测试保护 ACP 更新到页面状态和时间线的转换规则。
describe("ACP update state", () => {
  it("keeps agent messages, thoughts, plans and tool calls as distinct ACP data", () => {
    // 不同类型的 ACP 更新不能互相覆盖。
    let state = initialACPState();
    state = applySessionUpdate(
      state,
      textUpdate("agent_message_chunk", "正在分析。"),
    );
    state = applySessionUpdate(
      state,
      textUpdate("agent_thought_chunk", "先读取配置。"),
    );
    state = applySessionUpdate(state, {
      sessionUpdate: "plan",
      entries: [
        { content: "读取文件", priority: "high", status: "in_progress" },
      ],
    });
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "读取 README",
      status: "in_progress",
    });
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: "ok",
    });

    expect(state.message).toBe("正在分析。");
    expect(state.thought).toBe("先读取配置。");
    expect(state.plan[0].status).toBe("in_progress");
    expect(state.toolCalls[0]).toMatchObject({
      toolCallId: "tool-1",
      title: "读取 README",
      status: "completed",
      rawOutput: "ok",
    });
  });

  it("does not discard unknown ACP updates", () => {
    // 新增的协议通知先保留，避免前端升级前静默丢数据。
    const state = applySessionUpdate(initialACPState(), {
      sessionUpdate: "notice",
      message: "Agent changed mode",
    });

    expect(state.otherUpdates).toEqual([
      { sessionUpdate: "notice", message: "Agent changed mode" },
    ]);
  });

  it("keeps ACP activity but clears the streamed message once history has persisted it", () => {
    // 持久化后清理临时回复，但思考、计划和工具状态仍可继续展示。
    const state = {
      message: "最终回答",
      thought: "推理过程",
      plan: [{ content: "完成任务", status: "completed" }],
      toolCalls: [{ toolCallId: "tool-1", status: "completed" }],
      otherUpdates: [],
    };

    expect(clearPersistedAgentMessage(state)).toEqual({
      ...state,
      message: "",
    });
  });
});

describe("ACP prompt 时间线", () => {
  it("records live durations for thought and tool bubbles", () => {
    let timeline = applyTimelineUpdate([], textUpdate("agent_thought_chunk", "先想"), 100);
    timeline = applyTimelineUpdate(timeline, textUpdate("agent_thought_chunk", "再想"), 250);
    timeline = applyTimelineUpdate(timeline, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "读取配置",
      status: "in_progress",
    }, 500);
    timeline = applyTimelineUpdate(timeline, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    }, 800);

    expect(timeline[0]).toMatchObject({ startedAt: 100, durationMs: 400 });
    expect(timeline[1]).toMatchObject({ startedAt: 500, durationMs: 300 });
  });

  it("freezes an active bubble duration when the prompt completes", () => {
    let timeline = applyTimelineUpdate([], textUpdate("agent_thought_chunk", "思考中"), 100);
    timeline = completeTimeline(timeline, 900);

    expect(timeline[0]).toMatchObject({ startedAt: 100, durationMs: 800 });
  });

  it("keeps user text, thought, tool call, and agent text in ACP arrival order", () => {
    // 时间线顺序应和 ACP 到达顺序一致，用户能看懂 Agent 先做了什么再回答什么。
    let timeline = appendUserMessage([], "先检查配置");
    timeline = applyTimelineUpdate(
      timeline,
      textUpdate("agent_thought_chunk", "先读取配置。"),
    );
    timeline = applyTimelineUpdate(timeline, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "读取配置",
      status: "in_progress",
    });
    timeline = applyTimelineUpdate(
      timeline,
      textUpdate("agent_message_chunk", "配置已读取。"),
    );

    expect(timeline.map((item) => item.kind)).toEqual([
      "message",
      "thought",
      "tool_call",
      "message",
    ]);
    expect(timeline[0]).toMatchObject({ role: "user", text: "先检查配置" });
    expect(timeline[1].text).toBe("先读取配置。");
    expect(timeline[2]).toMatchObject({
      title: "读取配置",
      status: "in_progress",
    });
    expect(timeline[3]).toMatchObject({
      role: "assistant",
      text: "配置已读取。",
      streaming: true,
    });
  });

  it("updates a tool call in its original timeline position", () => {
    // 工具完成通知要更新原卡片，不能在时间线末尾重复生成一张新卡片。
    let timeline = applyTimelineUpdate([], {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "读取配置",
      status: "in_progress",
    });
    timeline = applyTimelineUpdate(
      timeline,
      textUpdate("agent_message_chunk", "稍等。"),
    );
    timeline = applyTimelineUpdate(timeline, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: "ok",
    });

    expect(timeline.map((item) => item.kind)).toEqual(["tool_call", "message"]);
    expect(timeline[0]).toMatchObject({ status: "completed", rawOutput: "ok" });
  });
});

function textUpdate(sessionUpdate: string, text: string) {
  return { sessionUpdate, content: { type: "text", text } };
}
