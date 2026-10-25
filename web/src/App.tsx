import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { ACPActivity } from "./components/ACPActivity";
import { useSession } from "./hooks/useSession";
import "./styles.css";

// App 只负责把“页面状态”接到“页面布局”上，不直接处理网络请求。
// 具体的 session 加载、消息发送和 ACP 连接都集中在 useSession 中。
export default function App() {
  const controller = useSession();
  const activeSession = controller.sessions.find(
    (session) => session.ID === controller.sessionID,
  );
  return (
    <main className="workspace">
      <Sidebar
        sessions={controller.sessions}
        sessionID={controller.sessionID}
        onNewSession={controller.newSession}
        onSelectSession={controller.selectSession}
      />
      <SessionView
        activeSession={activeSession}
        timeline={controller.timeline}
        text={controller.text}
        sending={controller.sending}
        turnStatus={controller.turnStatus}
        error={controller.error}
        permissionRequest={controller.permissionRequest}
        onTextChange={controller.setText}
        onSubmit={controller.send}
        onPermissionResponse={controller.respondToPermission}
      />
    </main>
  );
}

// 保留这个导出，方便调试 ACP 活动，也兼容已有调用方。
export { ACPActivity };
