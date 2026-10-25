# tinyAgent 维护规则

这份文件给接手项目的人和自动化维护工具看。先读根目录 [README.md](README.md)，再按 [文档地图](docs/README.md) 找对应手册。

## 先记住 8 条规则

1. **不要随便改对外名字。** URL、HTTP 状态码、JSON 字段、环境变量名、数据库表名和 Kubernetes 资源名，都是不同模块之间约好的“门牌号”。改一个，网页、部署脚本或云端环境可能互相找不到。
2. **不要提交秘密。** API Key、数据库连接串、证书私钥、阿里云 AccessKey 和真实账号信息，只能通过运行时 Secret 或本机安全配置提供。
3. **把 `pulumi up` 当作施工。** 它会创建或修改真实云资源，可能产生费用；运行前必须看 `pulumi preview`。
4. **把 `pulumi destroy` 当作拆房子。** 它会删除 Pulumi 管理的资源，可能让数据无法恢复；运行前必须确认数据责任人和清理范围。
5. **默认不要跑真实集成测试。** 带 `integration` 标签的 Go 测试会使用真实网页、沙箱和模型服务，可能收费。
6. **不要修改 `.reference-src/`。** 那里是上游参考代码，不是 tinyAgent 的业务实现；需要改功能时只改项目自己的目录。
7. **先看测试和同目录注释。** 代码不是孤立的，测试通常说明了最不能破坏的行为。
8. **每次改完先本地验证。** 先跑和改动范围对应的检查，最后跑 `make verify`。

## 目录地图

| 位置 | 白话解释 | 改动时最容易踩的坑 |
| --- | --- | --- |
| `web/` | 浏览器聊天页面 | `/api/sessions` 和 WebSocket 事件格式必须兼容后端。 |
| `cmd/tinyagent/` | Go 服务启动入口 | 启动顺序依赖配置、数据库和 Kubernetes。 |
| `cmd/sandbox-bridge/` | 沙箱里的数据转发程序 | 只能转发 ACP 字节流，普通日志不能写入同一条数据流。 |
| `internal/config/` | 读取并检查环境变量 | `DATABASE_URL` 没有默认值，缺失时必须明确报错。 |
| `internal/httpapi/` | 浏览器 HTTP/WebSocket 接口 | 给用户稳定、看得懂的错误；详细原因留在日志。 |
| `internal/session/` | 聊天记录、ACP 编号和发送锁 | 空列表必须返回 `[]`，不能返回 `null`。 |
| `internal/sandbox/` | 领取、等待、连接和回收沙箱 | 删除 Claim 后，还要回收已经领用的 Sandbox。 |
| `internal/acpproxy/` | 浏览器与 Codex 的 ACP 转发层 | 转发数据和旁路保存消息是两件事，不能混在一起。 |
| `internal/agent/` | Codex 启动配置 | 固定工作目录不能随便改，否则 AI 找不回会话文件。 |
| `agent-image/` | 沙箱镜像和启动脚本 | 密钥只能在运行时注入，不能烤进镜像。 |
| `infra/` | 阿里云和 Kubernetes 施工图 | 先 preview，确认资源和费用后才能发布。 |
| `docs/` | 给维护人看的手册 | 改了代码行为后要同步更新对应说明。 |

## 改完后跑什么

| 改动范围 | 必做检查 |
| --- | --- |
| Go 代码或注释旁边的 Go 结构 | `go test ./...` |
| 网页代码或网页数据约定 | `cd web && npm test -- --run && npm run build` |
| `infra/` | `cd infra && npm run build`，如有 infra 测试再跑 `node --test *.test.mjs` |
| 任意普通改动 | `make verify` |
| 云端部署相关改动 | 先人工阅读手册和 `pulumi preview`；不要自动执行 `pulumi up` |

## 绝对不能跨过的业务边界

- 浏览器接口的地址、状态码和 JSON 字段是对外约定。
- WebSocket 仍使用 `delta`、`done`、`error` 三种事件；改变前必须同时改网页、后端和测试。
- PostgreSQL 保存展示消息和 ACP session ID；AgenticFS 保存 Codex 会话文件，两者不能互相替代。
- 沙箱必须通过 `SandboxClaim` 从预热池领取；不要把沙箱 IP 直接暴露给浏览器。
- Claim 删除后仍要检查本次领用的 Sandbox 是否回收，不能只看 Claim 消失就认为清理完成。

## 日常工作顺序

1. 从 README 和文档地图找到相关手册。
2. 找到负责功能的目录，先读同目录测试和关键注释。
3. 先调整测试，再改实现；如果只是文档或注释，也要确认没有改到代码行为。
4. 跑对应检查，最后跑 `make verify`。
5. 涉及真实账号、密钥、发布或删除资源时，先停下来确认账号、范围、费用和数据风险。
