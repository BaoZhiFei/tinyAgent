# 架构说明：一次提问到底发生了什么

把 tinyAgent 想成一家只有一位 AI 员工的临时办公室：浏览器是前台，Go 后端是调度员，Sandbox 是临时办公室，Codex 是员工，模型服务是员工的大脑。

```text
浏览器
  │ HTTP：列出对话、创建对话、读取历史
  │ WebSocket：发送问题、接收 ACP 流式结果
  ▼
Go 后端
  ├─ PostgreSQL：保存网页要显示的消息和 ACP session ID
  ├─ SandboxClaim：从预热池借一台隔离小电脑
  └─ bridge：连接沙箱里的 Codex
              │
              ▼
           Codex Agent ── 模型 API
              │
              └── AgenticFS：保存 Codex 恢复工作所需的文件
```

## 各部分只负责什么

| 部分 | 白话解释 | 它不负责什么 |
| --- | --- | --- |
| `web/` | 用户看到的页面，负责输入、显示消息和权限选项。 | 不保存模型密钥，不直接访问沙箱。 |
| `internal/httpapi/` | 接待浏览器请求，把内部错误翻译成稳定的 HTTP 错误。 | 不自己操作数据库表或 Kubernetes。 |
| `internal/session/` | 管理网页历史、ACP session ID 和同一会话的占用锁。 | 不保存 Codex 的 rollout 文件。 |
| `internal/sandbox/` | 借用、等待、连接和回收隔离小电脑。 | 不决定 ACP 消息格式。 |
| `internal/acpproxy/` | 在浏览器和 Codex 之间转发 ACP 数据，并旁路记录最终消息。 | 不把 ACP 文档改成旧的 `delta/done/error` 私有协议。 |
| `internal/agent/` | 准备 Codex 需要的模型和认证环境变量。 | 不直接代替 Codex 调模型。 |
| `cmd/sandbox-bridge/` | 在沙箱内部把后端连接转给 Codex。 | 不把日志写进 ACP 数据流。 |
| `infra/` | 描述云端网络、ACK、数据库、沙箱池、入口和静态 PV。 | 不等于自动执行 `pulumi up`。 |

## 一次提问的 8 步

1. 页面调用 `POST /api/sessions` 创建或使用一个对话。
2. 用户点击发送，页面连接 `/api/sessions/{id}/prompt`，并升级成 WebSocket。
3. 后端先给这个 session 加租约。租约就是“正在处理”的标记，防止两个页面同时修改同一个 AI 会话。
4. 后端创建 `SandboxClaim`，从 `SandboxSet/tinyagent-pool` 领取一台预热沙箱。
5. 后端等待 Sandbox 进入 `Running`、`Ready=True` 并拿到内部 IP，然后连接沙箱业务容器的 `8080` bridge。
6. 浏览器发送 ACP 的 `initialize`、`session/new` 或 `session/load`、`session/prompt`。Codex 的 `session/update` 和权限请求原样经过后端返回。
7. 观察器只提取用户文字、助手文字和 ACP session ID，写入 PostgreSQL；它不修改正在转发的 ACP JSON-RPC。
8. 连接结束后按反方向清理：关闭 ACP 流、删除 Claim、回收本次领用的 Sandbox、释放 session 租约。Claim 消失不代表 Sandbox 一定自动消失，所以两步都必须做。

## 为什么有两种记忆

| 保存位置 | 保存内容 | 用途 |
| --- | --- | --- |
| PostgreSQL | 用户和 AI 看得见的消息、ACP session ID | 页面刷新后显示历史，并知道下次要恢复哪个 ACP session。 |
| AgenticFS | Codex 的会话文件和工作上下文 | 让 Codex 能继续上一次没有做完的工作。 |

ACP session ID 只是“下一次该找哪段会话”的编号，不是会话文件本身。固定目录 `/home/agent/.codex/sessions` 和 `/home/agent/workspace` 不能随意改，否则网页可能还有历史，但 AI 已经找不到自己的工作记忆。

## 端口和边界

- 浏览器只连接公开的 `/prompt`，不能直接连接 Sandbox IP。
- `8080` 是 tinyAgent bridge 的业务端口；`49983` 是 ACK runtime 控制端口，不能混用。
- Go 后端负责调度和转发，网页负责 ACP Client 展示，Codex 负责真正的 AI 工作。
- PostgreSQL 和 AgenticFS 不能互相替代。

排查时按这条路线走：配置 → PostgreSQL/租约 → Claim/Sandbox → `8080` bridge → ACP → 消息落库 → Claim/Sandbox 回收。页面能打开，只能说明入口活着，不能说明整条链路都正常。
