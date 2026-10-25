import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import App, { ACPActivity } from "./App";
import { TurnStatusCard } from "./components/TurnStatusCard";

const { createACPClient } = vi.hoisted(() => ({ createACPClient: vi.fn() }));
vi.mock("./acp", () => ({ createACPClient }));

describe("tinyAgent 页面", () => {
  beforeEach(() => {
    createACPClient.mockReset();
    createACPClient.mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue("acp-session-1"),
      prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
      respondToPermission: vi.fn().mockReturnValue(false),
      close: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("展示发送入口", () => {
    // 首屏必须始终能开始新任务，即使历史接口还没有返回。
    render(<App />);
    expect(screen.getByLabelText("任务内容")).toBeTruthy();
  });

  it("首次加载后自动创建预热 session 并显示准备状态", async () => {
    const fetch = vi.fn((url, options) => {
      if (url === "/api/sessions" && options?.method === "POST")
        return Promise.resolve({
          ok: true,
          json: async () => ({ ID: "task-1", Title: "新任务" }),
        });
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal("fetch", fetch);

    render(<App />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(screen.getByLabelText("本轮执行状态")).toBeTruthy();
    await waitFor(() => expect(createACPClient).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createACPClient.mock.results[0].value.connect).toHaveBeenCalledTimes(1));
  });

  it("点击新任务立即创建 session 并开始 ACP 预热", async () => {
    const fetch = vi.fn((url, options) => {
      if (url === "/api/sessions" && options?.method === "POST")
        return Promise.resolve({
          ok: true,
          json: async () => ({ ID: "task-1", Title: "新任务" }),
        });
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/sessions"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "新任务", exact: true })[0]);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ method: "POST" }),
    ));
    await waitFor(() => expect(createACPClient).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createACPClient.mock.results[0].value.connect).toHaveBeenCalledTimes(1));
  });

  it("发送时复用已预热的 ACP client", async () => {
    const client = {
      connect: vi.fn().mockResolvedValue("acp-session-1"),
      prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
      respondToPermission: vi.fn().mockReturnValue(false),
      close: vi.fn().mockResolvedValue(undefined),
    };
    createACPClient.mockReturnValue(client);
    vi.stubGlobal("fetch", vi.fn((url, options) => {
      if (url === "/api/sessions" && options?.method === "POST")
        return Promise.resolve({ ok: true, json: async () => ({ ID: "task-1", Title: "新任务" }) });
      if (url === "/api/sessions/task-1/messages")
        return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve({ ok: true, json: async () => [] });
    }));
    render(<App />);
    await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "复用连接" } });
    fireEvent.submit(screen.getByLabelText("任务内容").closest("form"));

    await waitFor(() => expect(client.prompt).toHaveBeenCalledWith("复用连接"));
    expect(createACPClient).toHaveBeenCalledTimes(1);
  });

  it("预热未完成时发送会等待同一个连接准备 Promise", async () => {
    let resolveConnect;
    const client = {
      connect: vi.fn(() => new Promise((resolve) => { resolveConnect = resolve; })),
      prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
      respondToPermission: vi.fn().mockReturnValue(false),
      close: vi.fn().mockResolvedValue(undefined),
    };
    createACPClient.mockReturnValue(client);
    vi.stubGlobal("fetch", vi.fn((url, options) => {
      if (url === "/api/sessions" && options?.method === "POST")
        return Promise.resolve({ ok: true, json: async () => ({ ID: "task-1", Title: "新任务" }) });
      return Promise.resolve({ ok: true, json: async () => [] });
    }));
    render(<App />);
    await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "等待预热" } });
    fireEvent.submit(screen.getByLabelText("任务内容").closest("form"));
    expect(client.prompt).not.toHaveBeenCalled();

    resolveConnect("acp-session-1");
    await waitFor(() => expect(client.prompt).toHaveBeenCalledWith("等待预热"));
  });

  it("开始另一个新任务时关闭旧的预热连接", async () => {
    const clients = [];
    createACPClient.mockImplementation(() => {
      const client = {
        connect: vi.fn().mockResolvedValue("acp-session"),
        prompt: vi.fn(),
        respondToPermission: vi.fn().mockReturnValue(false),
        close: vi.fn().mockResolvedValue(undefined),
      };
      clients.push(client);
      return client;
    });
    let nextID = 0;
    vi.stubGlobal("fetch", vi.fn((url, options) => {
      if (url === "/api/sessions" && options?.method === "POST") {
        nextID += 1;
        return Promise.resolve({ ok: true, json: async () => ({ ID: `task-${nextID}`, Title: "新任务" }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }));
    render(<App />);
    await waitFor(() => expect(clients).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("button", { name: "新任务", exact: true })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "新任务", exact: true })[0]);

    await waitFor(() => expect(clients).toHaveLength(2));
    expect(clients[0].close).toHaveBeenCalledTimes(1);
  });

  it("创建会话请求尚未返回时，立即显示刚发送的用户消息", async () => {
    // 发送体验不应被创建 session 的网络延迟阻塞，用户问题要先出现在时间线上。
    let resolveCreate;
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options) => {
        if (url === "/api/sessions" && options?.method !== "POST") {
          return Promise.resolve({
            ok: true,
            json: async () => [],
          });
        }
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("任务内容")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("任务内容"), {
      target: { value: "请立刻显示我" },
    });
    fireEvent.submit(screen.getByLabelText("任务内容").closest("form"));

    expect(screen.getByText("请立刻显示我")).toBeTruthy();
    expect(screen.getByLabelText("本轮执行状态")).toBeTruthy();
    resolveCreate?.({
      ok: true,
      json: async () => ({ ID: "task-1", Title: "请立刻显示我" }),
    });
  });

  it("发送进行中点击新任务后重新启用输入框", async () => {
    let resolveCreate;
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options) => {
        if (url === "/api/sessions" && options?.method !== "POST") {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("任务内容")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("任务内容"), {
      target: { value: "正在执行的任务" },
    });
    fireEvent.submit(screen.getByLabelText("任务内容").closest("form"));
    fireEvent.click(screen.getByRole("button", { name: /新任务/ }));

    expect(screen.getByLabelText("任务内容").disabled).toBe(false);
    resolveCreate?.({ ok: true, json: async () => ({ ID: "task-2", Title: "正在执行的任务" }) });
  });

  it("打开页面时保留空白草稿，不自动打开历史会话", async () => {
    // 刷新页面只加载历史按钮，不擅自替用户打开某条历史记录。
    const fetch = vi.fn((url) => {
      if (url === "/api/sessions") {
        return Promise.resolve({
          ok: true,
          json: async () => [{ ID: "task-1", Title: "已有会话" }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "已有会话" })).toBeTruthy(),
    );

    expect(screen.getByText("开始会话")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/sessions/task-1/messages",
    );
  });

  it("接口意外返回 null 时仍保留可用的发送入口", async () => {
    // 后端空列表应是 []；即使异常返回 null，前端也不能因此失去输入框。
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => null }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("任务内容")).toBeTruthy());
  });

  // 这条测试守住演示页的边界：技术实现留在文档里，空页面只给用户一个直接开始的入口。
  // 若以后又把 Sandbox、PostgreSQL 或 AgenticFS 的说明塞回首屏，演示时会重新显得像开发调试页。
  it("空会话只展示简洁引导而不展示技术说明", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByText("开始会话")).toBeTruthy());
    expect(screen.queryByText("阿里云 Sandbox 中的 Agent")).toBeNull();
    expect(screen.queryByText(/历史记录在 PostgreSQL/)).toBeNull();
  });

  // 这条测试守住刷新后的消息外观。数据库接口返回 Role/Text 大写字段，而发送中的消息
  // 使用小写字段；若不在边界统一，用户自己的历史消息会被误画成 Agent 气泡。
  it("历史消息与刚发送的消息使用相同的角色区分", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options) => {
        if (url === "/api/sessions" && options?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ID: "draft-1", Title: "新任务" }),
          });
        }
        if (url === "/api/sessions") {
          return Promise.resolve({
            ok: true,
            json: async () => [{ ID: "task-1", Title: "整理演示材料" }],
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => [
            { Role: "user", Text: "请整理演示材料" },
            { Role: "assistant", Text: "好的，我来整理。" },
          ],
        });
      }),
    );
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "整理演示材料" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "整理演示材料" }));
    await waitFor(() =>
      expect(screen.getByText("请整理演示材料")).toBeTruthy(),
    );
    expect(
      screen
        .getByText("请整理演示材料")
        .closest(".message")
        ?.classList.contains("user"),
    ).toBe(true);
    expect(
      screen
        .getByText("好的，我来整理。")
        .closest(".message")
        ?.classList.contains("assistant"),
    ).toBe(true);
  });

  // 这条测试守住聊天区自己的滚动边界。任务列表再长也不能把整页撑高，
  // 加载一段历史会话后，阅读位置应直接落在最新消息，而不是停在页面顶端。
  it("加载历史消息后会定位到最新消息", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options) => {
        if (url === "/api/sessions" && options?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ID: "draft-1", Title: "新任务" }),
          });
        }
        if (url === "/api/sessions") {
          return Promise.resolve({
            ok: true,
            json: async () => [{ ID: "task-1", Title: "滚动验证" }],
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => [{ Role: "assistant", Text: "最后一条消息" }],
        });
      }),
    );
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "滚动验证" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "滚动验证" }));
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" }),
    );
  });

  it("把 ACP 思考、计划和工具状态分别可视化", () => {
    // 辅助活动要各自展示，最终回答仍保持普通消息的显示方式。
    render(
      <ACPActivity
        state={{
          message: "完成了。",
          thought: "先检查配置。",
          plan: [{ content: "读取配置", status: "completed" }],
          toolCalls: [
            { toolCallId: "tool-1", title: "读取文件", status: "completed" },
          ],
          otherUpdates: [],
        }}
      />,
    );

    expect(screen.getByText("深度思考")).toBeTruthy();
    expect(screen.getByText("执行计划")).toBeTruthy();
    expect(screen.getByText("读取文件")).toBeTruthy();
    expect(screen.getByText("完成了。")).toBeTruthy();
  });

  it("展示本轮连接、沙箱来源和带解释的准备阶段", () => {
    render(
      <TurnStatusCard
        status={{
          phase: "sandbox_waiting",
          label: "等待沙箱就绪",
          sandboxSource: "warm_pool",
          startedAt: 0,
          phaseStartedAt: 100,
          websocketMs: 20,
          sandboxMs: undefined,
          agentMs: undefined,
          firstReplyMs: undefined,
          thoughtMs: undefined,
          toolMs: undefined,
          totalMs: undefined,
          toolStarts: {},
        }}
      />,
    );

    expect(screen.getByText("正在等待沙箱就绪")).toBeTruthy();
    expect(screen.queryByText("预热池沙箱", { exact: true })).toBeNull();
    expect(screen.queryByText(/会话已存在/)).toBeNull();
    expect(screen.queryByText(/WebSocket 握手/)).toBeNull();
    expect(screen.getByText("展开详情")).toBeTruthy();

    fireEvent.click(screen.getByText("展开详情"));

    expect(screen.getByText("收起详情")).toBeTruthy();
    expect(screen.getByText(/会话已存在/)).toBeTruthy();
    expect(screen.getByText(/WebSocket 握手/)).toBeTruthy();
    expect(screen.getByText(/预热池沙箱就绪/)).toBeTruthy();
    expect(screen.getByLabelText(/从浏览器开始建立 WebSocket/)).toBeTruthy();
    expect(screen.getAllByText("未发生").length).toBeGreaterThan(0);
  });

  it("在状态栏展示从发送到首个 AI 内容的总耗时", () => {
    render(
      <TurnStatusCard
        status={{
          phase: "responding",
          label: "生成回复",
          startedAt: 0,
          phaseStartedAt: 900,
          firstReplyMs: 900,
          now: 900,
          toolStarts: {},
        }}
      />,
    );

    expect(screen.getByText(/首 token 总耗时/)).toBeTruthy();
    expect(screen.getByText("0.9s")).toBeTruthy();
    expect(screen.getByLabelText(/从点击发送开始，到浏览器收到第一段 AI 内容/)).toBeTruthy();
  });
});
