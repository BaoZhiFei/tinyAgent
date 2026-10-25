import { describe, expect, it, vi } from "vitest";
import { acpWebSocketURL, createACPClient, sessionMethodFor } from "./acp";

// 这些测试保护 ACP 连接的地址、初始化顺序、会话恢复和通知过滤行为。
describe("ACP browser client", () => {
  it("opens the ACP prompt endpoint for a session", () => {
    // WebSocket 地址必须和当前页面同源，并保留开发服务器端口。
    expect(acpWebSocketURL("session-1")).toBe(
      `ws://${window.location.host}/api/sessions/session-1/prompt`,
    );
  });

  it("creates or loads an ACP session from the persisted session ID", () => {
    // 有保存的 ACP 编号时恢复，没有时才创建新会话。
    expect(sessionMethodFor("")).toBe("session/new");
    expect(sessionMethodFor("session-1")).toBe("session/load");
  });

  it("initializes ACP, opens a new session, and prompts over one connection", async () => {
    // 一次提问只使用一条连接，并按 initialize → session/new → prompt 顺序发送。
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agentCapabilities: { loadSession: true } })
      .mockResolvedValueOnce({ sessionId: "session-1" })
      .mockResolvedValueOnce({ stopReason: "end_turn" });
    const connectWith = vi.fn(async (_stream, callback) =>
      callback({ request }),
    );
    const client = createACPClient(
      { sessionID: "session-1" },
      fakeDependencies(connectWith),
    );

    await client.connect();
    await client.prompt("请解释 ACP");

    expect(request).toHaveBeenNthCalledWith(
      1,
      "initialize",
      expect.objectContaining({ protocolVersion: 1 }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "session/new",
      expect.objectContaining({ cwd: "/home/agent/workspace" }),
    );
    expect(request).toHaveBeenNthCalledWith(3, "session/prompt", {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "请解释 ACP" }],
    });
  });

  it("reuses one initialized connection for multiple prompts", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agentCapabilities: {} })
      .mockResolvedValueOnce({ sessionId: "session-1" })
      .mockResolvedValue({ stopReason: "end_turn" });
    const connectWith = vi.fn(async (_stream, callback) => callback({ request }));
    const dependencies = fakeDependencies(connectWith);
    const client = createACPClient(
      { sessionID: "session-1" },
      dependencies,
    );

    await client.connect();
    await client.prompt("第一条");
    await client.prompt("第二条");

    expect(dependencies.createStream).toHaveBeenCalledTimes(1);
    expect(connectWith).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("session/prompt", {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "第二条" }],
    });
  });

  it("reconnects after the server closes the idle stream and loads the ACP session", async () => {
    const request = vi.fn(async (method) => {
      if (method === "initialize") return { agentCapabilities: {} };
      if (method === "session/new") return { sessionId: "session-1" };
      if (method === "session/load") return {};
      return { stopReason: "end_turn" };
    });
    const connectWith = vi.fn((_stream, callback) => {
      void callback({ request });
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error("server closed idle stream")), 0);
      });
    });
    const client = createACPClient(
      { sessionID: "session-1" },
      fakeDependencies(connectWith),
    );

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await client.prompt("断线后继续");

    expect(connectWith).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("session/load", expect.objectContaining({ sessionId: "session-1" }));
  });

  it("loads a persisted ACP session instead of creating a new one", async () => {
    // 恢复场景不能误发 session/new，否则 Agent 会丢掉之前的工作上下文。
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agentCapabilities: { loadSession: true } })
      .mockResolvedValueOnce({});
    const client = createACPClient(
      {
        sessionID: "session-1",
        previousSessionID: "persisted-session",
      },
      fakeDependencies(async (_stream, callback) => callback({ request })),
    );

    await client.connect();

    expect(request).toHaveBeenNthCalledWith(
      2,
      "session/load",
      expect.objectContaining({ sessionId: "persisted-session" }),
    );
  });

  it("drops replayed updates during session loading and forwards updates from the new prompt", async () => {
    // session/load 的旧通知不应显示成新回复；真正 prompt 的通知必须继续交给页面。
    let permissionHandler;
    let notificationHandler;
    const receivedUpdates = [];
    const receivedPermissions = [];
    const request = vi.fn(async (method) => {
      if (method === "initialize")
        return { agentCapabilities: { loadSession: true } };
      if (method === "session/load") return {};
      if (method === "session/prompt") {
        notificationHandler({
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "tool_call", toolCallId: "new-turn" },
          },
        });
        return { stopReason: "end_turn" };
      }
    });
    const connectWith = vi.fn(async (_stream, callback) => {
      const connection = callback({ request });
      await Promise.resolve();
      notificationHandler({
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "old turn" },
          },
        },
      });
      const permission = permissionHandler({
        params: { options: [{ optionId: "approve-terminal", name: "允许" }] },
      });
      return connection.then(async () => permission);
    });
    const client = createACPClient(
      {
        sessionID: "session-1",
        previousSessionID: "session-1",
        onSessionUpdate: (params) => receivedUpdates.push(params),
        onPermissionRequest: (params) => receivedPermissions.push(params),
      },
      fakeDependencies(connectWith, {
        onRequest: (handler) => (permissionHandler = handler),
        onNotification: (handler) => (notificationHandler = handler),
      }),
    );

    const ready = client.connect();
    await Promise.resolve();
    await client.prompt("new turn");
    client.respondToPermission("approve-terminal");
    await ready;

    expect(receivedUpdates).toEqual([
      {
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call", toolCallId: "new-turn" },
      },
    ]);
    expect(receivedPermissions[0].options[0].optionId).toBe("approve-terminal");
  });

  it("does not report an error when the client intentionally closes its ACP stream", async () => {
    let finishConnection;
    const errors = [];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agentCapabilities: { loadSession: true } })
      .mockResolvedValueOnce({ sessionId: "session-1" });
    const connectWith = vi.fn(async (_stream, callback) => {
      await callback({ request });
      throw new Error("stream closed");
    });
    const client = createACPClient(
      {
        sessionID: "session-1",
        onError: (error) => errors.push(error.message),
      },
      fakeDependencies(connectWith, {
        onNotification: () => {},
        onRequest: () => {},
      }),
    );

    await client.connect();
    finishConnection = client.close();
    await finishConnection;
    await Promise.resolve();

    expect(errors).toEqual([]);
  });

  it("forwards additive server lifecycle status notifications", async () => {
    const statuses = [];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agentCapabilities: {} })
      .mockResolvedValueOnce({ sessionId: "session-1" });
    const client = createACPClient(
      { sessionID: "session-1", onStatus: (status) => statuses.push(status) },
      fakeDependencies(async (_stream, callback) => callback({ request }), {
        onStatus: (handler) => handler({ params: { phase: "sandbox_waiting", label: "等待沙箱就绪" } }),
      }),
    );

    await client.connect();

    expect(statuses).toEqual([{ phase: "sandbox_waiting", label: "等待沙箱就绪" }]);
  });

  it("accepts the agent auth status notification during initialization", async () => {
    let authNotificationRegistered = false;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agentCapabilities: {} })
      .mockResolvedValueOnce({ sessionId: "session-1" });
    const client = createACPClient(
      { sessionID: "session-1" },
      fakeDependencies(async (_stream, callback) => callback({ request }), {
        onAuthNotification: () => {
          authNotificationRegistered = true;
        },
      }),
    );

    await expect(client.connect()).resolves.toBe("session-1");
    expect(authNotificationRegistered).toBe(true);
  });
});

function fakeDependencies(connectWith, registrations = {}) {
  const chain = {
    onRequest: (_method, handler) => {
      registrations.onRequest?.(handler);
      return chain;
    },
    onNotification: (method, parserOrHandler, maybeHandler) => {
      if (method === "session/update") {
        registrations.onNotification?.(maybeHandler ?? parserOrHandler);
      }
      if (method === "tinyagent/status") {
        if (maybeHandler === undefined) {
          throw new Error(
            "Unknown ACP notification method 'tinyagent/status'. Pass a params parser for custom methods.",
          );
        }
        registrations.onStatus?.(maybeHandler);
      }
      if (method === "_auth/status_update") {
        if (maybeHandler === undefined) {
          throw new Error(
            "Unknown ACP notification method '_auth/status_update'. Pass a params parser for custom methods.",
          );
        }
        registrations.onAuthNotification?.(maybeHandler);
      }
      return chain;
    },
    connectWith,
  };
  return {
    createStream: vi.fn(() => ({ writable: { close: vi.fn() } })),
    client: vi.fn(() => chain),
    methods: {
      agent: {
        initialize: "initialize",
        session: {
          new: "session/new",
          load: "session/load",
          prompt: "session/prompt",
        },
      },
      client: {
        session: {
          requestPermission: "session/request_permission",
          update: "session/update",
        },
      },
    },
    protocolVersion: 1,
  };
}
