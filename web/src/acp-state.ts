import type {
  ACPState,
  ACPUpdate,
  PlanTimelineItem,
  TimelineItem,
} from "./types";

// 这些纯函数把 ACP 的零散通知整理成页面能直接渲染的状态。
// 它们都返回新数组或新对象，不直接修改 React 当前状态。
export function initialACPState(): ACPState {
  return {
    message: "",
    thought: "",
    plan: [],
    toolCalls: [],
    otherUpdates: [],
  };
}

export function appendUserMessage(
  timeline: TimelineItem[],
  text: string,
): TimelineItem[] {
	// 用户消息在发送前先放进时间线，让页面立即显示，不必等待后端创建 session。
  return [...timeline, { kind: "message", role: "user", text }];
}

export function applyTimelineUpdate(
  timeline: TimelineItem[],
  update: ACPUpdate,
  now = Date.now(),
): TimelineItem[] {
	// ACP 通知按到达顺序进入时间线；工具更新会回到原来的工具卡片位置。
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return appendStreamText(closeOpenThought(timeline, now), "message", textOf(update), now);
    case "agent_thought_chunk":
      return appendStreamText(timeline, "thought", textOf(update), now);
    case "plan":
      return replaceLatest(closeOpenThought(timeline, now), "plan", {
        kind: "plan",
        entries: update.entries ?? [],
      });
    case "tool_call":
      return [
        ...closeOpenThought(timeline, now),
        {
          ...update,
          kind: "tool_call",
          toolCallId: update.toolCallId ?? "",
          startedAt: now,
          ...(update.status === "completed" ? { durationMs: 0 } : {}),
        },
      ];
    case "tool_call_update":
      return timeline.map((item) =>
        item.kind === "tool_call" && item.toolCallId === update.toolCallId
          ? {
              ...item,
              ...update,
              kind: "tool_call",
              ...(update.status === "completed" && item.startedAt !== undefined
                ? { durationMs: now - item.startedAt }
                : {}),
            }
          : item,
      );
    default:
      return [...timeline, { kind: "other", update }];
  }
}

export function completeTimeline(timeline: TimelineItem[], now = Date.now()): TimelineItem[] {
	// prompt 完成后，正在流式显示的 Agent 消息变成普通历史消息。
  return finalizeOpenActivities(timeline, now).map((item) =>
    item.kind === "message" && item.role === "assistant" ? { ...item, streaming: false } : item,
  );
}

export function clearPersistedAgentMessage(state: ACPState): ACPState {
	// 数据库已经保存最终回复后，只清掉临时流式副本，保留思考、计划和工具记录。
  return { ...state, message: "" };
}

export function applySessionUpdate(
  state: ACPState,
  update: ACPUpdate,
): ACPState {
	// 这是给 ACPActivity 使用的汇总状态；未知通知也要留下，避免静默丢失新协议字段。
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return { ...state, message: state.message + textOf(update) };
    case "agent_thought_chunk":
      return { ...state, thought: state.thought + textOf(update) };
    case "plan":
      return { ...state, plan: update.entries ?? [] };
    case "tool_call":
      return { ...state, toolCalls: [...state.toolCalls, update] };
    case "tool_call_update":
      return {
        ...state,
        toolCalls: state.toolCalls.map((call) =>
          call.toolCallId === update.toolCallId ? { ...call, ...update } : call,
        ),
      };
    default:
      return { ...state, otherUpdates: [...state.otherUpdates, update] };
  }
}

function textOf(update: ACPUpdate): string {
	// 只有文本内容能直接拼到消息或思考区域，其他内容交给各自的更新分支处理。
  return update.content?.type === "text" ? update.content.text : "";
}

function appendStreamText(
  timeline: TimelineItem[],
  kind: "message" | "thought",
  text: string,
  now: number,
): TimelineItem[] {
	// 连续文本片段合并到最后一个同类项目；中间出现工具或计划时则开启新的项目。
  if (!text) return timeline;
  const last = timeline.at(-1);
  if (
    last &&
    ((kind === "message" && last.kind === "message" && last.streaming) ||
      (kind === "thought" && last.kind === "thought"))
  ) {
    return [...timeline.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...timeline,
    kind === "message"
      ? { kind: "message", role: "assistant", text, streaming: true }
      : { kind: "thought", text, startedAt: now },
  ];
}

function closeOpenThought(timeline: TimelineItem[], now: number): TimelineItem[] {
  return timeline.map((item) =>
    item.kind === "thought" && item.durationMs === undefined && item.startedAt !== undefined
      ? { ...item, durationMs: now - item.startedAt }
      : item,
  );
}

function finalizeOpenActivities(timeline: TimelineItem[], now: number): TimelineItem[] {
  return timeline.map((item) =>
    (item.kind === "thought" || item.kind === "tool_call") &&
    item.durationMs === undefined &&
    item.startedAt !== undefined
      ? { ...item, durationMs: now - item.startedAt }
      : item,
  );
}

function replaceLatest(
  timeline: TimelineItem[],
  kind: PlanTimelineItem["kind"],
  replacement: PlanTimelineItem,
): TimelineItem[] {
	// 计划通知代表当前计划的整体快照，所以替换最后一份计划，而不是不断追加旧版本。
  const index = timeline.findLastIndex((item) => item.kind === kind);
  if (index < 0) return [...timeline, replacement];
  return timeline.map((item, itemIndex) =>
    itemIndex === index ? replacement : item,
  );
}
