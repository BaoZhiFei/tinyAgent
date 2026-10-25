# 配置和密钥

配置就是程序启动前收到的一张“工作说明”。程序会检查必填项，发现缺失就立即退出，而不是等用户第一次提问时才失败。这样排查更容易。

## Go 后端环境变量

| 名称 | 白话解释 | 是否必填/默认值 | 什么时候改 |
| --- | --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 的地址、账号和密码 | 必填；无默认值；敏感 | 换数据库或部署环境时。 |
| `LISTEN_ADDRESS` | Go 服务监听哪个地址和端口 | 必填；无默认值 | 端口冲突时。 |
| `SANDBOX_NAMESPACE` | 沙箱放在哪个 Kubernetes 命名空间 | 必填；无默认值 | 命名空间整体调整时。 |
| `SANDBOX_POOL_NAME` | 预热沙箱池的名字 | 必填；无默认值 | 同步修改 Pulumi 施工图时。 |
| `AGENTICFS_PV_NAME` | Kubernetes 里静态卷的名字 | 必填；无默认值 | 存储资源命名方案改变时。 |
| `KUBECONFIG_PATH` | 本地调试时连接 Kubernetes 的文件 | 本地可选；线上通常为空；敏感 | 只用于本地调试，不能提交文件。 |
| `SANDBOX_CLAIM_TIMEOUT` | 最多等多久才能借到并准备好沙箱 | 必填；无默认值 | 沙箱确实变慢且已有证据时。 |
| `IDLE_TIMEOUT` | 保留给业务层的空闲超时配置 | 必填；无默认值 | 先确认代码使用位置，再改。 |
| `MAX_LIFETIME` | 一台已借用沙箱最多运行多久 | 必填；无默认值 | 单次任务确实需要更久时。 |

时间使用 Go 格式，例如 `30s`、`5m`、`1h`。格式错误会阻止服务启动。

云端没有 `KUBECONFIG_PATH` 时，后端使用 Pod 自己的 ServiceAccount；本地如果设置 `LOCAL_ACP_ENDPOINT`，后端会连接 Docker Compose 里的 bridge，不创建 `SandboxClaim`。

## 云端 Pulumi 配置

`infra/` 的 Pulumi 配置决定要创建哪些云资源。示例配置在 `infra/Pulumi.dev.yaml.example`，真实配置不要提交 Git。

| 配置 | 做什么 | 风险 |
| --- | --- | --- |
| `tinyagent:name`、`clusterSpec`、`zoneId` | 项目名、ACK 规格和可用区 | 规格会影响费用；可用区必须匹配。 |
| `tinyagent:domain`、`certificateID` | 公网域名和 HTTPS 证书 | 填错会让入口不可用。 |
| `tinyagent:apiImage`、`webImage`、`agentImage` | 三个镜像地址 | 镜像版本不一致会造成前后端行为不匹配。 |
| `tinyagent:listenAddress`、`sandboxNamespace`、`sandboxPoolName`、`persistentVolumeName` | 应用和 Kubernetes 资源名 | 名字是跨模块约定，不能随便改。 |
| `tinyagent:sandboxClaimTimeout`、`idleTimeout`、`maxLifetime` | 沙箱等待、空闲和最长使用时间 | 过短会误判失败，过长会占用资源。 |
| `tinyagent:warmPoolSize`、`managerNodeCount`、`managerNodeInstanceType` | 预热池数量和管理节点规格 | 会直接影响持续费用。 |
| `tinyagent:modelProvider`、`modelProviderName`、`modelBaseURL`、`model` | 使用哪家模型和哪个模型 | 要确认服务商地址和模型名称。 |
| `tinyagent:modelApiKey` | 模型服务密钥 | 敏感，必须用 `pulumi config set --secret`。 |
| `tinyagent:agenticFileSystemID`、`agenticFSAccessPointID`、`agenticFSAccessPointDomain` | 当前外部 AgenticFS 的入口信息 | 属于内部基础设施信息，不能写进公开示例。 |

模型 API Key 是给 Codex 调模型的；阿里云 RAM 凭据是给 Pulumi 操作云资源的。两者用途不同，但都不能公开。密钥流向应是“Pulumi Secret → Kubernetes Secret → 沙箱运行时”，不应进入浏览器、镜像层、Git 或 PostgreSQL 展示消息。

## 改配置前后怎么做

1. 先看 [部署到阿里云](deployment-aliyun.md)，确认账号、区域和费用。
2. 改一个配置后先运行 `pulumi preview`，看它准备改哪些资源。
3. 确认没有意外替换、删除或扩容后，才由负责人执行 `pulumi up`。
4. 不确定配置含义时，不要猜值；先看代码读取位置和测试。
