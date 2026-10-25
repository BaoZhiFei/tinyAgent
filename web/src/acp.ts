import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import type { ACPUpdate, PermissionRequest, TurnStatusEvent } from "./types";

// 这里必须和沙箱里 Codex 的工作目录完全一致；否则 session/load 找不到上一次的文件。
export const AGENT_WORKSPACE = "/home/agent/workspace";

export interface ACPClientOptions {
  sessionID: string;
  previousSessionID?: string;
  onSessionReady?: (sessionID: string) => void;
  onSessionUpdate?: (params: { update: ACPUpdate }) => void;
  onStatus?: (status: TurnStatusEvent) => void;
  onPermissionRequest?: (request: PermissionRequest) => void;
  onError?: (error: Error) => void;
}

export interface ACPClient {
  connect(): Promise<string>;
  prompt(text: string): Promise<unknown>;
  respondToPermission(optionID?: string): boolean;
  close(): Promise<void>;
}

interface ACPConnection {
  request(method: unknown, params?: unknown): Promise<any>;
}

interface ACPChain {
  onRequest(
    method: unknown,
    handler: (request: { params: PermissionRequest }) => Promise<unknown>,
  ): ACPChain;
  onNotification(
    method: unknown,
    handlerOrParams: unknown,
    handler?: (notification: { params: unknown }) => void,
  ): ACPChain;
  connectWith(
    stream: unknown,
    callback: (context: ACPConnection) => Promise<void>,
  ): Promise<void>;
}

export interface ACPDependencies {
  createStream(url: string): { writable: { close(): Promise<void> | void } };
  client(): ACPChain;
  methods: any;
  protocolVersion: number;
}

export function sessionMethodFor(
  previousSessionID: string,
): "session/load" | "session/new" {
	// 有旧编号就恢复，没有就新建；这是网页 session 和 ACP session 的衔接点。
  return previousSessionID ? "session/load" : "session/new";
}

export function acpWebSocketURL(sessionID: string): string {
	// 根据当前页面是否使用 HTTPS 选择 ws 或 wss，确保浏览器不因混合内容拦截连接。
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/sessions/${sessionID}/prompt`;
}

export function createACPClient(
  options: ACPClientOptions,
  dependencies: ACPDependencies = defaultDependencies,
): ACPClient {
	// 这里把 SDK 的连接细节包起来，对外只提供 connect、prompt、权限响应和 close 四个动作。
  const {
    sessionID,
    previousSessionID = "",
    onSessionReady = () => {},
    onSessionUpdate = () => {},
    onStatus = () => {},
    onPermissionRequest = () => {},
    onError = () => {},
  } = options;
  let context: ACPConnection | undefined;
  let acpSessionID = previousSessionID;
  let persistedSessionID = previousSessionID;
  let stream: ReturnType<ACPDependencies["createStream"]> | undefined;
  let closeConnection: (() => void) | undefined;
  let pendingPermission: ((value: unknown) => void) | undefined;
  let connectPromise: Promise<string> | undefined;
  let closedByClient = false;
  let promptStarted = false;

  function connect(): Promise<string> {
	// 同一个客户端只建立一次连接；重复调用会共用第一次连接的 Promise。
    if (connectPromise) return connectPromise;
    closedByClient = false;
    promptStarted = false;
    stream = dependencies.createStream(acpWebSocketURL(sessionID));
    let resolveReady!: (sessionID: string) => void;
    let rejectReady!: (error: Error) => void;
    connectPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const activeConnectPromise = connectPromise;
    const connection = dependencies
      .client()
      .onRequest(
        dependencies.methods.client.session.requestPermission,
        ({ params }) =>
          new Promise((resolve) => {
			// ACP 会暂停等待这里的结果。页面选择允许或取消后，
			// respondToPermission 会完成这个 Promise，让 Agent 继续运行。
            pendingPermission = resolve;
            onPermissionRequest(params);
          }),
      )
      .onNotification(
        dependencies.methods.client.session.update,
        ({ params }) => {
			// session/load 可能先重播旧通知；只有 prompt 开始后才交给页面展示。
          if (promptStarted) onSessionUpdate(params);
        },
      )
      .onNotification(
        "tinyagent/status",
        {
          parse: (params: unknown) => params as TurnStatusEvent,
        },
        ({ params }) => {
          onStatus(params as TurnStatusEvent);
        },
      )
      .onNotification(
        "_auth/status_update",
        {
          // codex-acp 在初始化时会发这条厂商自定义通知。tinyAgent 不需要处理它，
          // 但必须先登记这个消息，否则 ACP 路由器可能把正常连接当成未知消息而中止。
          parse: (params: unknown) => params,
        },
        () => {},
      )
      .connectWith(stream, async (nextContext) => {
        context = nextContext;
		// 先初始化协议，再新建或恢复 ACP session，最后才允许 prompt 发问题。
        await context.request(dependencies.methods.agent.initialize, {
          protocolVersion: dependencies.protocolVersion,
          clientCapabilities: {},
        });
        const session = await context.request(
          persistedSessionID
            ? dependencies.methods.agent.session.load
            : dependencies.methods.agent.session.new,
          persistedSessionID
            ? {
                sessionId: persistedSessionID,
                cwd: AGENT_WORKSPACE,
                mcpServers: [],
              }
            : { cwd: AGENT_WORKSPACE, mcpServers: [] },
        );
        acpSessionID = persistedSessionID || session.sessionId;
        persistedSessionID = acpSessionID;
        onSessionReady(acpSessionID);
        resolveReady(acpSessionID);
        await new Promise<void>((resolve) => {
          closeConnection = resolve;
        });
      });
    connection.catch((error: Error) => {
      rejectReady(error);
      if (!closedByClient) {
        if (connectPromise === activeConnectPromise) {
          connectPromise = undefined;
          context = undefined;
          stream = undefined;
          closeConnection = undefined;
        }
        onError(error);
      }
    });
    return connectPromise;
  }

  async function prompt(text: string): Promise<unknown> {
	// prompt 负责发送本轮问题；连接和 session 准备工作由 connect 统一完成。
    await connect();
    promptStarted = true;
    return context!.request(dependencies.methods.agent.session.prompt, {
      sessionId: acpSessionID,
      prompt: [{ type: "text", text }],
    });
  }

  function respondToPermission(optionID?: string): boolean {
	// optionID 为空表示取消。无待处理请求时返回 false，避免误完成别的权限请求。
    if (!pendingPermission) return false;
    const resolve = pendingPermission;
    pendingPermission = undefined;
    resolve(
      optionID
        ? { outcome: { outcome: "selected", optionId: optionID } }
        : { outcome: { outcome: "cancelled" } },
    );
    return true;
  }

  async function close(): Promise<void> {
	// 关闭前先取消挂起的权限请求，再唤醒连接回调，最后关闭 WebSocket 流。
    closedByClient = true;
    respondToPermission();
    closeConnection?.();
    await stream?.writable.close();
  }

  return { connect, prompt, respondToPermission, close };
}

const defaultDependencies: ACPDependencies = {
  createStream: createWebSocketStream,
  client: acp.client as unknown as () => ACPChain,
  methods: acp.methods,
  protocolVersion: acp.PROTOCOL_VERSION,
};
