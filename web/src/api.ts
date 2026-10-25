import type { Session, StoredMessage } from "./types";

/**
 * 浏览器调用后端 session 接口的地方。
 * 页面组件只调用这些函数，不需要知道 URL、HTTP 方法和 JSON 细节。
 */
export async function listSessions(): Promise<Session[]> {
	// 后端按最近更新时间返回历史列表；异常时抛出用户能看懂的错误。
  const response = await fetch("/api/sessions");
  if (!response.ok) throw new Error("无法读取历史 session");
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as Session[]) : [];
}

export async function createSession(
  title = "新 session",
): Promise<Session> {
	// 创建的只是网页 session 记录，还不会启动 Agent；真正提问时才建立 ACP 连接。
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error("无法创建 session");
  return response.json() as Promise<Session>;
}

export async function listMessages(id: string): Promise<StoredMessage[]> {
	// 后端消息字段可能是首字母大写，交给 message.ts 在边界处统一处理。
  const response = await fetch(`/api/sessions/${id}/messages`);
  if (!response.ok) throw new Error("无法读取消息");
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as StoredMessage[]) : [];
}
