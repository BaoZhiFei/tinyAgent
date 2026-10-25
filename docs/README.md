# tinyAgent 文档地图

如果你第一次接手项目，先看根目录的 [README](../README.md)。然后根据你现在要做的事情选择下面的一页，不需要先把所有技术名词学会。

## 我想先弄懂系统

- [架构说明](architecture.md)：一次提问从网页到 Go 后端、沙箱、Codex，再回到网页的完整过程。
- [配置和密钥](configuration.md)：程序启动需要什么，哪些值敏感，改一个值会影响什么。
- [浏览器接口约定](browser-api.md)：网页和后端之间固定的地址、状态码、JSON 字段和 WebSocket 约定。

## 我想在电脑上检查代码

- [本地检查](local-checks.md)：安装工具、跑免费检查、启动本地 Docker 环境，以及哪些检查会调用模型并收费。
- 根目录 `make verify`：一次跑完 Go、网页和 infra 的本地检查。

## 我想部署或演示

- [部署到阿里云](deployment-aliyun.md)：准备账号、配置 Pulumi、预览、发布、配置 DNS/HTTPS 和清理资源。
- [云端验收](cloud-acceptance.md)：发布后按清单确认网页、数据库、沙箱、挂载和回收。
- [演示指南](demo-guide.md)：现场演示前怎么准备，演示时看什么，结束后怎么收尾。

## 我遇到了问题

- [排查问题](troubleshooting.md)：按“现象 → 证据 → 可能原因 → 安全动作”一步一步排查。
- 先看网页错误和 Go 日志，再看 Kubernetes 对象；不要一上来删除 Claim、Sandbox 或整个集群。

## 重要提醒

`pulumi preview` 会读取云账号，`pulumi up` 会创建或修改真实资源，`pulumi destroy` 会删除资源。它们都不是普通测试命令。真实集成测试也可能调用模型并产生费用。
