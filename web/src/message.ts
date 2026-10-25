import type { DisplayMessage, MessageRole, StoredMessage } from "./types";

// 后端历史消息使用首字母大写字段，浏览器刚发出的消息使用小写字段。
// 在接口边界统一后，组件只需要处理一种形状，也不会把用户消息误画成 Agent 消息。
export function normalizeMessage(message: StoredMessage): DisplayMessage {
  const role = String(
    message.role ?? message.Role ?? "assistant",
  ).toLowerCase();
  return {
    ...message,
    role: (role === "user" ? "user" : "assistant") as MessageRole,
    text: String(message.text ?? message.Text ?? ""),
  };
}
