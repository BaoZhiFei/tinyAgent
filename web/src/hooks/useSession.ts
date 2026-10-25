import { useCallback, useEffect, useRef, useState } from "react";
import { createSession, listSessions, listMessages } from "../api";
import { createACPClient, type ACPClient } from "../acp";
import {
  appendUserMessage,
  applyTimelineUpdate,
  completeTimeline,
} from "../acp-state";
import {
  applyACPActivity,
  applyServerStatus,
  failTurn,
  finishTurn,
  initialTurnStatus,
  markACPReady,
  markSessionCreateStarted,
  markSessionCreated,
  markWebSocketStarted,
  startPromptStatus,
  tickTurnStatus,
} from "../turn-state";
import { normalizeMessage } from "../message";
import type { Session, PermissionRequest, TimelineItem, TurnStatusEvent } from "../types";
import type { TurnStatusState } from "../turn-state";

export interface SessionController {
  sessions: Session[];
  sessionID: string;
  timeline: TimelineItem[];
  text: string;
  sending: boolean;
  turnStatus: TurnStatusState | null;
  error: string;
  permissionRequest: PermissionRequest | null;
  setText(text: string): void;
  selectSession(id: string): void;
  newSession(): void;
  send(event: React.FormEvent<HTMLFormElement>): Promise<void>;
  respondToPermission(optionID?: string): void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface PreparedSession {
  generation: number;
  ready: Promise<{ session: Session; client: ACPClient } | null>;
  client?: ACPClient;
}

/**
 * 集中管理一次聊天从打开页面到结束的全部状态。
 *
 * 可以把它理解成“页面总管”：负责加载历史、准备新 session、建立 WebSocket、
 * 把 ACP 的实时消息放进时间线、处理权限确认，并在结束后刷新左侧列表。
 * 页面组件只消费这里返回的状态和按钮动作，不直接协调这些异步步骤。
 */
export function useSession(): SessionController {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionID, setSessionID] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [prewarming, setPrewarming] = useState(false);
  const [turnStatus, setTurnStatus] = useState<TurnStatusState | null>(null);
  const [error, setError] = useState("");
  const [permissionRequest, setPermissionRequest] =
    useState<PermissionRequest | null>(null);
  const acpClientRef = useRef<ACPClient | null>(null);
  const preparedSessionRef = useRef<PreparedSession | null>(null);
  const initialPrewarmRef = useRef(false);
  const mountedRef = useRef(true);
  const turnGenerationRef = useRef(0);
  const sessionsRef = useRef<Session[]>([]);
  const skipNextMessageLoadRef = useRef(false);

  const loadSessions = useCallback(async (): Promise<boolean> => {
	// 页面打开和每轮提问结束后都刷新列表，确保左侧标题和 ACP session ID 是最新的。
    try {
      setSessions(await listSessions());
      return true;
    } catch (loadError) {
      setError(errorMessage(loadError, "无法读取历史 session"));
      return false;
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
	// 切换历史 session 时读取持久化消息，并统一成页面时间线中的 message 项。
    try {
      const messages = await listMessages(id);
      setTimeline(
        messages.map((message) => ({
          kind: "message",
          ...normalizeMessage(message),
        })),
      );
    } catch (loadError) {
      setError(errorMessage(loadError, "无法读取消息"));
    }
  }, []);

  useEffect(() => {
	// sessionID 改变通常表示用户点了历史记录；新建 session 的首次发送则跳过一次空消息加载。
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!sessionID) return;
    if (skipNextMessageLoadRef.current) {
      skipNextMessageLoadRef.current = false;
      return;
    }
    void loadMessages(sessionID);
  }, [sessionID, loadMessages]);

  useEffect(
    () => () => {
		mountedRef.current = false;
		// 页面卸载或组件销毁时关闭 WebSocket，避免后台继续占用沙箱。
      void acpClientRef.current?.close();
    },
    [],
  );

  useEffect(() => {
    if (!sending && !prewarming) return;
    const timer = window.setInterval(() => {
      setTurnStatus((status) => (status ? tickTurnStatus(status, Date.now()) : status));
    }, 250);
    return () => window.clearInterval(timer);
  }, [prewarming, sending]);

  const closeActiveClient = useCallback(async () => {
    const prepared = preparedSessionRef.current;
    preparedSessionRef.current = null;
    const client = acpClientRef.current ?? prepared?.client;
    acpClientRef.current = null;
    await client?.close();
  }, []);

  const createClient = useCallback((activeID: string, previousSessionID: string, generation: number) => {
    return createACPClient({
      sessionID: activeID,
      previousSessionID,
      onSessionReady: (acpSessionID) => {
        if (turnGenerationRef.current !== generation) return;
        setTurnStatus((current) =>
          current ? markACPReady(current, Date.now()) : current,
        );
        setSessions((items) =>
          items.map((session) =>
            session.ID === activeID
              ? { ...session, ACPSessionID: acpSessionID }
              : session,
          ),
        );
      },
      onSessionUpdate: ({ update }) => {
        if (turnGenerationRef.current !== generation) return;
        const now = Date.now();
        setTimeline((items) => applyTimelineUpdate(items, update, now));
        setTurnStatus((current) =>
          current ? applyACPActivity(current, update, now) : current,
        );
      },
      onStatus: (status: TurnStatusEvent) => {
        if (turnGenerationRef.current !== generation) return;
        setTurnStatus((current) =>
          current ? applyServerStatus(current, status, Date.now()) : current,
        );
      },
      onPermissionRequest: (request) => {
        if (turnGenerationRef.current === generation) setPermissionRequest(request);
      },
      onError: (acpError) => {
        if (turnGenerationRef.current === generation)
          setError(acpError.message || "ACP 连接已断开");
      },
    });
  }, []);

  const newSession = useCallback(() => {
	// 新任务会取消上一轮连接，避免旧请求继续占用输入框或把结果写进新会话。
    if (initialPrewarmRef.current && preparedSessionRef.current) {
      initialPrewarmRef.current = false;
      return;
    }
    const generation = ++turnGenerationRef.current;
    void closeActiveClient();
    setError("");
    setSessionID("");
    setTimeline([]);
    setText("");
    setSending(false);
    setPrewarming(true);
    setPermissionRequest(null);
    setTurnStatus(initialTurnStatus());

    const prepared: PreparedSession = {
      generation,
      ready: Promise.resolve(null),
    };
    preparedSessionRef.current = prepared;
    prepared.ready = (async () => {
      setTurnStatus((current) =>
        current ? markSessionCreateStarted(current, Date.now()) : current,
      );
      const created = await createSession("新任务");
      if (!mountedRef.current || turnGenerationRef.current !== generation) return null;
      setTurnStatus((current) =>
        current ? markSessionCreated(current, Date.now()) : current,
      );
      setSessionID(created.ID);
      skipNextMessageLoadRef.current = true;
      setSessions((items) => [created, ...items.filter((item) => item.ID !== created.ID)]);

      const client = createClient(created.ID, created.ACPSessionID ?? "", generation);
      prepared.client = client;
      acpClientRef.current = client;
      setTurnStatus((current) =>
        current ? markWebSocketStarted(current, Date.now()) : current,
      );
      const acpSessionID = await client.connect();
      if (!mountedRef.current || turnGenerationRef.current !== generation) {
        await client.close();
        return null;
      }
      setSessions((items) =>
        items.map((item) =>
          item.ID === created.ID ? { ...item, ACPSessionID: acpSessionID } : item,
        ),
      );
      return { session: created, client };
    })();
    void prepared.ready
      .catch((prewarmError) => {
        if (mountedRef.current && turnGenerationRef.current === generation) {
          initialPrewarmRef.current = false;
          setError(errorMessage(prewarmError, "无法连接 Agent"));
          setTurnStatus((current) => (current ? failTurn(current, Date.now()) : current));
        }
        return null;
      })
      .finally(() => {
        if (turnGenerationRef.current === generation) setPrewarming(false);
      });
  }, [closeActiveClient, createClient]);

  useEffect(() => {
    // 首屏加载历史列表后，后台立即准备一个可直接发送的新 session；不打开任何历史消息。
    let active = true;
    void loadSessions().then((loaded) => {
      if (active && loaded) {
        initialPrewarmRef.current = true;
        newSession();
      }
    });
    return () => {
      active = false;
    };
  }, [loadSessions, newSession]);

  const respondToPermission = useCallback((optionID?: string) => {
	// 页面按钮的选择交给当前 ACP 客户端，再立即收起权限提示。
    acpClientRef.current?.respondToPermission(optionID);
    setPermissionRequest(null);
  }, []);

  const send = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
		// 一次 send 覆盖“显示用户问题 → 创建 session → 建立 ACP → 流式接收 → 刷新历史”的完整链路。
      event.preventDefault();
      const prompt = text.trim();
      if (!prompt || sending) return;

      const generation = turnGenerationRef.current;
      try {
        initialPrewarmRef.current = false;
        setTimeline((items) => appendUserMessage(items, prompt));
        setPermissionRequest(null);
        setText("");
        setError("");
        setSending(true);
        const prepared = preparedSessionRef.current;
        setTurnStatus((current) =>
          current && prepared?.generation === generation
            ? startPromptStatus(current, Date.now())
            : startPromptStatus(initialTurnStatus(), Date.now()),
        );
        let activeID = sessionID;
        let client: ACPClient;
        if (prepared?.generation === generation) {

			const ready = await prepared.ready;
          if (!ready) return;
          activeID = ready.session.ID;
          client = ready.client;
        } else if (!activeID) {
			// 首次发送时才创建后端 session，并把用户问题立即显示在页面上。
          setTurnStatus((current) =>
            current ? markSessionCreateStarted(current, Date.now()) : current,
          );
          const created = await createSession(prompt.slice(0, 40));
          if (turnGenerationRef.current !== generation) return;
          setTurnStatus((current) =>
            current ? markSessionCreated(current, Date.now()) : current,
          );
          activeID = created.ID;
          skipNextMessageLoadRef.current = true;
          setSessionID(activeID);
          setSessions((items) => [created, ...items]);
          client = createClient(activeID, created.ACPSessionID ?? "", generation);
        } else {
          const previousSessionID = sessionsRef.current.find(
            (session) => session.ID === activeID,
          )?.ACPSessionID;
          client = createClient(activeID, previousSessionID ?? "", generation);
        }
        acpClientRef.current = client;
        await client.prompt(prompt);
		if (turnGenerationRef.current !== generation) return;
		// prompt 返回后保留连接，下一轮问题复用同一个 ACP session。
        await loadSessions();
        setTimeline((items) => completeTimeline(items, Date.now()));
        setTurnStatus((current) => (current ? finishTurn(current, Date.now()) : current));
      } catch (sendError) {
		if (turnGenerationRef.current !== generation) return;
        setError(errorMessage(sendError, "无法连接 Agent"));
        setTurnStatus((current) => (current ? failTurn(current, Date.now()) : current));
        await closeActiveClient();
      } finally {
        setSending(false);
      }
    },
    [closeActiveClient, createClient, loadSessions, sending, sessionID, text],
  );

  const selectSession = useCallback((id: string) => {
    initialPrewarmRef.current = false;
    turnGenerationRef.current += 1;
    void closeActiveClient();
    setPrewarming(false);
    setSending(false);
    setError("");
    setTurnStatus(null);
    setText("");
    setTimeline([]);
    setSessionID(id);
  }, [closeActiveClient]);

  return {
    sessions,
    sessionID,
    timeline,
    text,
    sending,
    turnStatus,
    error,
    permissionRequest,
    setText,
    selectSession,
    newSession,
    send,
    respondToPermission,
  };
}
