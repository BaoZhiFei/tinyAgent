import type { ACPState } from "../types";
import { stringify } from "./TimelineItem";

// 展示 Agent 的辅助活动，不把思考、计划和工具调用混进最终回复气泡。
// 没有对应内容时不渲染空面板，避免聊天区出现多余空白。
export function ACPActivity({ state }: { state: ACPState }) {
  return (
    <section className="acp-activity" aria-label="ACP Agent 活动">
      {state.thought && (
        <details>
          <summary>深度思考</summary>
          <pre>{state.thought}</pre>
        </details>
      )}
      {state.plan.length > 0 && (
        <details open>
          <summary>执行计划</summary>
          <ol>
            {state.plan.map((item, index) => (
              <li key={index} data-status={item.status}>
                {item.content}
              </li>
            ))}
          </ol>
        </details>
      )}
      {state.toolCalls.length > 0 && (
        <details open>
          <summary>工具调用</summary>
          {state.toolCalls.map((call) => (
            <div className="tool-call" key={String(call.toolCallId)}>
              <strong>{String(call.title ?? "")}</strong>
              <span>{String(call.status || "pending")}</span>
              {Boolean(call.rawOutput) && (
                <pre>{stringify(call.rawOutput)}</pre>
              )}
            </div>
          ))}
        </details>
      )}
      {state.message && (
        <article className="message assistant streaming">
          <span className="message-label">tinyAgent</span>
          <div className="message-content">{state.message}</div>
        </article>
      )}
    </section>
  );
}
