# 浏览器接口约定

这页给需要改网页或排查浏览器请求的人看。浏览器是 ACP Client：它负责显示消息、显示状态和回答权限请求；模型密钥、沙箱 IP 和 Kubernetes 细节都不能进入浏览器。

## HTTP 接口

| 方法和地址 | 用途 | 成功结果 |
| --- | --- | --- |
| `GET /healthz` | 检查后端是否活着 | `200` |
| `GET /api/sessions` | 获取左侧对话列表 | `Session[]`，最近更新在前 |
| `POST /api/sessions` | 创建一个空对话 | `201` 和一个 `Session` |
| `GET /api/sessions/{id}/messages` | 获取某个对话的历史 | `Message[]`，按时间顺序 |

`Session.ACPSessionID` 是 ACP 会话编号。它不是聊天正文，而是告诉下一次连接应该用 `session/load` 还是 `session/new`。

没有历史时接口必须返回 JSON 空数组 `[]`，不能返回 `null`；网页会直接遍历数组。不存在的 session 返回 `404`，数据库等内部错误返回稳定的 `500` 和简短 `error` 字段，不能把数据库密码或 Kubernetes 错误直接返回浏览器。

## Prompt WebSocket

用户点击发送后，浏览器连接：

```text
GET /api/sessions/{id}/prompt
```

连接随后升级成 WebSocket。浏览器发送 ACP JSON-RPC 文档，例如：

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"…","prompt":[{"type":"text","text":"请用三句话解释 ACP"}]}}
```

浏览器通常依次发送 `initialize`、`session/new` 或 `session/load`、`session/prompt`。Codex 返回 `session/update`，也可能请求权限。后端只转发 ACP 文档，并旁路保存最终消息和 ACP session ID，不把它们重新编码成旧的私有事件。

## 页面如何理解消息

- `session/update` 里的回答文字显示在时间线上；
- 思考、计划和工具调用显示成对应的活动卡片；
- 权限请求由用户选择 ACP `optionId`，浏览器原样回复 `selected` 或 `cancelled`；
- prompt 结束后，后端保存合并后的最终助手文本，刷新页面仍能看到历史。

同一个 ACP session 同时只能运行一个 prompt turn。如果另一个页面已经在生成，升级 WebSocket 前会收到普通 HTTP 错误。

## tinyAgent 状态通知

WebSocket 成功后，服务端可能发送 `tinyagent/status`，告诉页面当前正在等沙箱、连接 Agent 还是生成回答。它是附加进度信息，不替代 ACP 文档：

```json
{"jsonrpc":"2.0","method":"tinyagent/status","params":{"phase":"sandbox_waiting","label":"等待沙箱就绪","sandboxSource":"warm_pool","elapsedMs":1234,"totalElapsedMs":1234}}
```

`phase` 可能是 `connecting`、`sandbox_claiming`、`sandbox_waiting`、`agent_connecting`、`agent_ready`、`thinking`、`tool_calling`、`responding`、`completed` 或 `failed`。`sandboxSource` 可能是 `warm_pool`、`provisioning` 或 `local`。

服务端不会发送 Sandbox IP、Claim 名称、密钥或底层错误。改动本页写到的地址、状态码、字段或 ACP 语义前，必须同时检查网页、Go 后端和测试。
