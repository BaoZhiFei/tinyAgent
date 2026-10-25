import type { TimelineItem as TimelineItemData } from "../types";

interface TimelineItemProps {
  item: TimelineItemData;
  now?: number;
}

// TimelineItem 把统一后的时间线项目转换成页面元素。
// 不同 kind 分开渲染，保证 Agent 的最终回答、思考过程和工具状态彼此独立。
export function TimelineItem({ item, now = Date.now() }: TimelineItemProps) {
  if (item.kind === "message")
    return (
      <article
        className={item.role === "user" ? "message user" : "message assistant"}
      >
        <span className="message-label">
          {item.role === "user" ? "我" : "tinyAgent"}
        </span>
        <div className="message-content">
          {item.text || (item.streaming ? "正在思考…" : "")}
        </div>
      </article>
    );
  if (item.kind === "thought")
    return (
      <section className="acp-activity">
        <details>
          <summary>{activityLabel("深度思考", item.startedAt, item.durationMs, now)}</summary>
          <pre>{item.text}</pre>
        </details>
      </section>
    );
  if (item.kind === "plan")
    return (
      <section className="acp-activity">
        <details open>
          <summary>执行计划</summary>
          <ol>
            {item.entries.map((entry, index) => (
              <li key={index} data-status={entry.status}>
                {entry.content}
              </li>
            ))}
          </ol>
        </details>
      </section>
    );
  if (item.kind === "tool_call")
    return (
      <section className="acp-activity">
        <details open>
          <summary>{activityLabel("工具调用", item.startedAt, item.durationMs, now)}</summary>
          <div className="tool-call">
            <strong>{String(item.title ?? "")}</strong>
            <span>{String(item.status || "pending")}</span>
            {Boolean(item.rawOutput) && <pre>{stringify(item.rawOutput)}</pre>}
          </div>
        </details>
      </section>
    );
  return null;
}

function activityLabel(label: string, startedAt?: number, durationMs?: number, now = Date.now()): string {
  if (startedAt === undefined) return label;
  const elapsed = durationMs ?? Math.max(0, now - startedAt);
  return `${durationMs === undefined ? `${label}中` : label} · ${(elapsed / 1000).toFixed(1)}s`;
}

export function stringify(value: unknown): string {
  // 工具输出可能本来就是字符串，也可能是对象；对象格式化后更方便阅读。
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
