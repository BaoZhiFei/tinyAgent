import { useEffect, useRef } from "react";
import type {
  Session,
  PermissionRequest,
  TimelineItem as TimelineItemData,
} from "../types";
import { Composer } from "./Composer";
import { PermissionRequest as PermissionRequestView } from "./PermissionRequest";
import { TimelineItem } from "./TimelineItem";
import { TurnStatusCard } from "./TurnStatusCard";
import type { TurnStatusState } from "../turn-state";

interface SessionViewProps {
  activeSession?: Session;
  timeline: TimelineItemData[];
  text: string;
  sending: boolean;
  turnStatus: TurnStatusState | null;
  error: string;
  permissionRequest: PermissionRequest | null;
  onTextChange(text: string): void;
  onSubmit(event: React.FormEvent<HTMLFormElement>): void;
  onPermissionResponse(optionID?: string): void;
}

// SessionView 负责当前对话区域的布局：标题、时间线、权限提示、错误和输入框。
// 它不决定消息如何产生，只把 useSession 提供的状态和回调传给子组件。
export function SessionView(props: SessionViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 新消息或历史消息加载后，把阅读位置移到最后，用户能直接看到最新内容。
    if (props.timeline.length)
      endRef.current?.scrollIntoView?.({ block: "end" });
  }, [props.timeline]);
  return (
    <section className="session">
      {props.activeSession && (
        <header className="session-title">
          {props.activeSession.Title || "新任务"}
        </header>
      )}
      <section
        className={props.timeline.length ? "messages has-messages" : "messages"}
        aria-live="polite"
      >
        {props.timeline.length ? (
          // TimelineItem 根据 kind 选择普通消息、思考、计划或工具调用的外观。
          props.timeline.map((item, index) => (
            <TimelineItem key={index} item={item} now={props.turnStatus?.now} />
          ))
        ) : (
          <div className="empty-state">
            <div className="agent-orb" aria-hidden="true">
              ✦
            </div>
            <h2>开始会话</h2>
          </div>
        )}
        {props.timeline.length > 0 && <div ref={endRef} aria-hidden="true" />}
      </section>
      <div className="composer-area">
        {props.permissionRequest && (
          <PermissionRequestView
            request={props.permissionRequest}
            onRespond={props.onPermissionResponse}
          />
        )}
        {props.error && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
        {props.turnStatus && <TurnStatusCard status={props.turnStatus} />}
        <Composer
          text={props.text}
          sending={props.sending}
          onChange={props.onTextChange}
          onSubmit={props.onSubmit}
        />
      </div>
    </section>
  );
}
