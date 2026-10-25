# tinyAgent

tinyAgent 是一个给浏览器使用的 AI 聊天演示系统。

用户在网页里输入问题后，系统会完成这几件事：

1. 网页把问题发给 Go 后端；
2. Go 后端从预热池借一台隔离的“小电脑”（Sandbox）；
3. 小电脑里的 Codex Agent 处理问题；
4. 回答通过 WebSocket 一段一段回到网页；
5. 对话文字存进 PostgreSQL，Codex 继续工作所需的会话文件存进 AgenticFS。

它不是“下载后双击就能运行”的普通聊天软件。完整的云端演示需要阿里云的 Kubernetes、沙箱、数据库、文件存储和模型服务。第一次接手时，先理解系统，再改代码或云资源。

## 第一次接手，按这个顺序看

1. 看本页，知道项目大致做什么。
2. 看 [维护规则](AGENTS.md)，知道哪些名字和接口不能改。
3. 看 [文档地图](docs/README.md)，按你的任务选择手册。
4. 只想确认本地代码是否正常时，运行：

   ```bash
   make verify
   ```

   这个命令只做本地检查：Go 测试、网页测试和构建、Pulumi TypeScript 构建。它不会创建云资源。

## 每个目录，用大白话理解

| 位置 | 它像什么 | 它负责什么 |
| --- | --- | --- |
| `web/` | 用户看到的前台 | 显示聊天页面，发送问题，显示回答和权限请求。 |
| `cmd/tinyagent/` | 总开关 | 读取配置，连接数据库和 Kubernetes，启动 Go 服务。 |
| `internal/httpapi/` | 前台接待 | 接收浏览器的 HTTP 和 WebSocket 请求，返回稳定的错误。 |
| `internal/session/` | 聊天记录柜 | 保存网页要显示的消息、ACP 会话编号和并发占用锁。 |
| `internal/sandbox/` | 借用小电脑的管理员 | 创建领取单、等待小电脑准备好、连接它、结束后回收。 |
| `internal/acpproxy/` | 电话转接员 | 在浏览器和沙箱里的 Codex 之间转发 ACP 数据，同时旁路记录消息。 |
| `internal/agent/` | AI 启动配置员 | 整理模型地址、模型名和运行时密钥，让 Codex 能启动。 |
| `cmd/sandbox-bridge/` | 沙箱里的电话线 | 只转发后端和 Codex 之间的字节数据，不能混入普通日志。 |
| `agent-image/` | 小电脑模板 | 安装 Codex 和 bridge，并定义沙箱启动顺序。 |
| `infra/` | 云端施工图 | 描述 VPC、ACK、RDS、沙箱池、入口和 Kubernetes 对象。 |
| `docs/` | 维护手册 | 解释系统、配置、部署、演示和排障。 |

## 两份“记忆”不是一回事

- PostgreSQL 保存用户能看到的聊天消息和 ACP session ID。它解决“网页刷新后还能看到什么”。
- AgenticFS 保存 Codex 恢复工作所需的会话文件。它解决“AI 下一次还能不能接着工作”。

删掉其中任何一份，聊天都可能无法完整恢复。详细流程看 [架构说明](docs/architecture.md)。

## 哪些命令有风险

| 命令 | 白话解释 | 风险 |
| --- | --- | --- |
| `make verify` | 在本机检查代码 | 低，不连接云端。 |
| `pulumi preview` | 让 Pulumi 列出准备改变的云资源 | 中，会读取云账号；要认真看计划。 |
| `pulumi up` | 真正创建或修改云资源 | 高，可能计费，也可能改线上环境。 |
| `pulumi destroy` | 删除这个 Pulumi stack 管理的资源 | 很高，可能删除数据，通常不可恢复。 |
| `go test -tags integration ./integration/...` | 使用真实网页、沙箱和模型服务 | 高，可能计费。 |

执行 `pulumi up` 或 `pulumi destroy` 前，必须确认账号、区域、费用、数据责任人和回收方案。不要把模型 API Key、数据库连接串、证书私钥或阿里云访问凭据写进 Git、镜像、截图或聊天记录。

## 继续阅读

- 想理解系统：看 [架构说明](docs/architecture.md)。
- 想改配置：看 [配置和密钥](docs/configuration.md)。
- 想在本机检查：看 [本地检查](docs/local-checks.md)。
- 想部署云端：看 [部署到阿里云](docs/deployment-aliyun.md)。
- 遇到问题：看 [排查问题](docs/troubleshooting.md)。
