/**
 * 左侧历史列表里的一条 session 摘要。
 * 字段名刻意保留 Go 接口返回的大写写法，不能为了好看改成小写。
 */
export interface Session {
  ID: string;
  Title: string;
  ACPSessionID?: string;
}

/**
 * 后端返回的历史消息，或浏览器刚加入时间线的临时消息。
 * 两种来源的字段大小写不同，统一入口会把它们整理成 DisplayMessage。
 */
export interface StoredMessage {
  Role?: string;
  Text?: string;
  role?: string;
  text?: string;
  [key: string]: unknown;
}

export type MessageRole = "user" | "assistant";

export interface DisplayMessage {
  /** 页面其余部分只处理这一种消息形状，避免重复判断字段大小写。 */
  role: MessageRole;
  text: string;
  [key: string]: unknown;
}

export interface PlanEntry {
  /** Agent 计划中的一步，以及这一步当前的状态。 */
  content: string;
  status?: string;
  priority?: string;
}

export interface ToolCall {
  /** 一次工具调用及其后续状态；同一个 toolCallId 会收到多次更新。 */
  kind: "tool_call";
  toolCallId: string;
  title?: string;
  status?: string;
  rawOutput?: unknown;
  startedAt?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export interface MessageTimelineItem {
  kind: "message";
  role: MessageRole;
  text: string;
  streaming?: boolean;
}

export interface ThoughtTimelineItem {
  kind: "thought";
  text: string;
  startedAt?: number;
  durationMs?: number;
}

export interface PlanTimelineItem {
  kind: "plan";
  entries: PlanEntry[];
}

export interface OtherTimelineItem {
  kind: "other";
  update: ACPUpdate;
}

export type TimelineItem =
  | MessageTimelineItem
  | ThoughtTimelineItem
  | PlanTimelineItem
  | ToolCall
  | OtherTimelineItem;

export interface ACPTextContent {
  type: "text";
  text: string;
}

export interface ACPUpdate {
  /** ACP 发来的单条活动更新；未知字段仍保留，协议扩展时页面不会静默丢数据。 */
  sessionUpdate: string;
  content?: ACPTextContent;
  entries?: PlanEntry[];
  toolCallId?: string;
  title?: string;
  status?: string;
  rawOutput?: unknown;
  [key: string]: unknown;
}

export interface ACPState {
  /** 活动面板需要的“最新汇总”，和时间线的“完整到达顺序”分开保存。 */
  message: string;
  thought: string;
  plan: PlanEntry[];
  toolCalls: Array<Omit<ToolCall, "kind">>;
  otherUpdates: ACPUpdate[];
}

export interface PermissionOption {
  optionId: string;
  name?: string;
}

export interface PermissionRequest {
  /** Agent 暂停执行，等待用户允许或取消某个动作。 */
  description?: string;
  title?: string;
  options: PermissionOption[];
}

export interface TurnStatusEvent {
  phase: string;
  label: string;
  sandboxSource?: "warm_pool" | "provisioning" | "local";
  elapsedMs?: number;
  totalElapsedMs?: number;
}
