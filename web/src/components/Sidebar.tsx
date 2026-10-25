import type { Session } from "../types";

interface SidebarProps {
  sessions: Session[];
  sessionID: string;
  onNewSession(): void;
  onSelectSession(id: string): void;
}

// Sidebar 只显示 session 列表和两个用户动作；当前选中项由 sessionID 决定。
export function Sidebar({
  sessions,
  sessionID,
  onNewSession,
  onSelectSession,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>tinyAgent</h1>
      </div>
      <button className="new-task" type="button" onClick={onNewSession}>
        <span aria-hidden="true">✎</span> 新任务
      </button>
      <nav className="task-list" aria-label="最近任务">
        <p className="list-label">最近任务</p>
        {sessions.map((session) => (
          <button
            key={session.ID}
            className={
              session.ID === sessionID ? "task active" : "task"
            }
            type="button"
            title={session.Title}
            onClick={() => onSelectSession(session.ID)}
          >
            <span>{session.Title || "新任务"}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
