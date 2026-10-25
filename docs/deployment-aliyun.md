# 部署到阿里云

这是一份真实云端施工手册。ACK、NAT、RDS、ALB、沙箱和模型服务都可能收费。没有确认账号、区域、预算、数据责任人和清理负责人时，停在本页，不要继续。

## 先看风险

| 命令/动作 | 白话解释 | 风险 |
| --- | --- | --- |
| `pulumi preview` | 只列出 Pulumi 准备改变什么 | 会读取云账号；通常不创建资源。 |
| `pulumi up` | 真正施工，创建或修改资源 | 可能计费，也可能影响现有环境。 |
| `pulumi destroy` | 拆掉这个 stack 管理的资源 | 可能删除环境和数据。 |
| 云端集成测试 | 借沙箱并调用模型 | 会消耗云资源和模型额度。 |

```text
浏览器 → ALB（公网入口）→ Web/API
                              ├─ PostgreSQL：网页聊天记录
                              ├─ AgenticFS：Codex 工作记忆
                              └─ SandboxSet：提前准备好的隔离小电脑
```

VPC 是这些组件共用的私有网络；ACK 是负责安排容器运行位置的阿里云 Kubernetes。不要手工用 `kubectl delete` 删除 Pulumi 管理的对象，否则代码里的施工图和真实云端会不一致。

## 1. 准备账号和位置

1. 使用独立的阿里云 CLI profile，例如 `tinyagent`，不要改默认 profile。
2. 本演示使用 `cn-shanghai` 和 `cn-shanghai-f`；ACK、AgenticFS、AccessPoint、VPC 和节点必须放在兼容位置。
3. 确认账号已经开通 AgenticFS，并准备好外部 FileSystem、AgenticSpace 和 AccessPoint。AccessPoint 必须启用 RAM 认证和 TLS。
4. 确认你登录的是正确账号。账号错了，preview 也可能看起来“正常”，但最后会把资源建到错误环境。

## 2. 构建并推送镜像

把 `<acr>` 替换成你的 ACR 地址：

```bash
release_tag="$(git rev-parse HEAD)"
docker build -t <acr>/tinyagent-api:demo -t <acr>/tinyagent-api:"$release_tag" .
docker build -f web/Dockerfile -t <acr>/tinyagent-web:demo -t <acr>/tinyagent-web:"$release_tag" web
docker build -f Dockerfile.agent -t <acr>/tinyagent-agent:demo -t <acr>/tinyagent-agent:"$release_tag" .
docker push <acr>/tinyagent-api:demo
docker push <acr>/tinyagent-api:"$release_tag"
docker push <acr>/tinyagent-web:demo
docker push <acr>/tinyagent-web:"$release_tag"
docker push <acr>/tinyagent-agent:demo
docker push <acr>/tinyagent-agent:"$release_tag"
```

镜像里不能放模型 API Key。Pulumi 只在运行时把 Secret 注入 Kubernetes。

## 3. 配置 Pulumi

```bash
cd infra
npm ci
pulumi stack init dev
pulumi config set alicloud:region cn-shanghai
pulumi config set alicloud:profile tinyagent
pulumi config set tinyagent:zoneId cn-shanghai-f
pulumi config set tinyagent:apiImage <acr>/tinyagent-api:demo
pulumi config set tinyagent:webImage <acr>/tinyagent-web:demo
pulumi config set tinyagent:agentImage <acr>/tinyagent-agent:demo
pulumi config set tinyagent:agenticFSAccessPointDomain <AccessPoint挂载域名>
pulumi config set tinyagent:agenticFSAccessPointID <AccessPointID>
pulumi config set tinyagent:agenticFileSystemID <AgenticFS文件系统ID>
pulumi config set --secret tinyagent:modelApiKey '<模型 API Key>'
```

还要按 [配置和密钥](configuration.md) 补齐模型名称、地址、命名空间、镜像和节点配置。真实配置文件不要提交 Git。

## 4. 先预览，再发布

```bash
pulumi preview
```

逐项看账号、区域、VPC、NAT、ACK 节点、RDS、预热池、ALB、AgenticFS 和费用。尤其注意 `delete`、`replace` 和数量异常的资源。

只有负责人确认计划和数据责任后，才运行：

```bash
pulumi up
```

成功信号是 stack 更新完成，并输出集群、命名空间、数据库和入口信息。挂载授权失败时先查 Agent Identity、CredentialProvider、AccessPoint 和 Sandbox 事件，不要把长期 AccessKey 放进 Pod。

## 5. DNS、HTTPS、验收和清理

首次发布后，找到 Ingress 的 ALB CNAME，在 DNS 中创建 CNAME。不要把域名指向节点 IP。证书签发并完成域名校验后，设置 `tinyagent:certificateID`，再次 preview，再由负责人执行 `pulumi up`。

按 [云端验收](cloud-acceptance.md) 检查网页、Claim、挂载、恢复、HTTPS 和回收。演示结束后记录 stack、集群、AgenticFS、部署时间和清理负责人。确定不保留环境时，先确认数据责任，再执行 `pulumi destroy`；它不是“关机”，而是删除资源。
