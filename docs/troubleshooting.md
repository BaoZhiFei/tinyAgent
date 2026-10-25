# 排查问题：先找卡住的那一层

先记下发生时间、用户看到的现象和请求 ID，再看日志。不要把密钥、完整 `DATABASE_URL` 或证书私钥复制到聊天、工单或截图。

## 固定排查路线

1. **配置层**：`DATABASE_URL` 是否存在，时间格式是否正确，是否误用了本地 ACP 地址。
2. **数据库层**：PostgreSQL 能否连接，session 是否存在，是否被另一个请求占用。
3. **沙箱层**：Claim 是否创建，Sandbox 是否 `Running`、`Ready=True`，是否有 `sandboxIp`。
4. **连接层**：后端是否能连接 Sandbox 内的 `8080` bridge；不要把 ACK runtime 的 `49983` 当成 ACP 端口。
5. **ACP 层**：是否完成 `session/new` 或 `session/load`、`session/prompt`；是否出现 `error`。
6. **持久化层**：展示消息和 ACP session ID 是否写入 PostgreSQL，会话文件是否写入 AgenticFS。
7. **回收层**：Claim 和本次领用的 Sandbox 是否都删除，预热池是否补回空闲实例。

## 常见现象

| 现象 | 先看什么 | 常见原因 | 安全动作 |
| --- | --- | --- | --- |
| 后端启动就退出 | 启动日志和 `DATABASE_URL` | 缺配置、时间格式错误、Kubernetes 配置不可读 | 按配置手册修正，不要猜线上地址。 |
| 页面空白或没有历史 | 浏览器请求、`GET /healthz`、API Pod 日志 | 网页没启动、API 没启动、历史接口失败 | 先跑 `make verify`，再查 API。 |
| 不能创建 session | `POST /api/sessions` 状态码和后端日志 | 数据库连接、路由或权限问题 | 不要直接改数据库表。 |
| 回答不出现或中途断开 | WebSocket、SandboxClaim、API 日志 | 沙箱未就绪、bridge 连接失败、模型失败或入口超时 | 按固定路线逐层检查。 |
| 一直领不到沙箱 | `kubectl -n tinyagent get sandboxclaims,sandboxes` 和事件 | 预热池空、镜像拉取失败、挂载或权限失败 | 不要删除整个预热池。 |
| 第二次提问像失忆 | PostgreSQL 的 ACP session ID、两个挂载目录 | 文件未持久化、工作目录被改、权限失败 | 检查固定目录和挂载，不要先重建数据库。 |
| HTTPS 不生效 | Ingress、CNAME、证书状态 | DNS 未生效、证书 ID 错、443 没创建 | 先确认 HTTP，再看部署手册。 |
| 演示结束仍担心收费 | Pulumi stack、ACK、NAT、RDS、预热池 | 资源还在运行 | 由负责人确认后再清理；`pulumi destroy` 有删除风险。 |

## “第二次提问像失忆”时逐项确认

- PostgreSQL 的 `agent_session_id` 是否在第一次 prompt 后保存；
- `/home/agent/.codex/sessions` 是否可写，并且 subPath 仍使用该对话编号；
- 第二次 prompt 是否发送 `session/load`，而不是误发 `session/new`；
- 后端和网页使用的 session ID 是否是同一个。

只有数据库里的指针和 AgenticFS 里的文件同时存在，ACP resume 才能恢复完整上下文。

排障原则是：先收集证据，再改最小范围；不要因为网页打不开就直接删除 Claim、重建集群或执行 destroy。
