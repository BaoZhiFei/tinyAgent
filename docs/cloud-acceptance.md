# 云端验收清单

这些检查访问真实环境，发送真实问题时会产生模型费用。每一项都要记录命令输出或截图。网页能打开，只说明入口活着，不代表数据库、沙箱、挂载和回收都正常。

## 验收顺序

- [ ] **网页可访问**：打开 HTTPS 域名，页面能加载且没有明显前端错误。
- [ ] **HTTP 跳 HTTPS**：`curl -I http://<域名>` 返回 30x 跳转。
- [ ] **能创建对话**：发送一句短问题，回答开始逐段出现。
- [ ] **沙箱被领取**：执行 `kubectl -n tinyagent get sandboxclaims,sandboxes`；Claim 存在，Sandbox 为 `Running`、`Ready=True` 并有 `sandboxIp`。
- [ ] **两份存储都能用**：`/home/agent/workspace` 和 `/home/agent/.codex/sessions` 都可写。
- [ ] **刷新后能恢复**：重新打开同一对话；网页历史来自 PostgreSQL，AI 上下文通过 ACP session 和 AgenticFS 恢复。
- [ ] **结束后会回收**：Claim 和本次领用的 Sandbox 被删除，`SandboxSet/tinyagent-pool` 仍补回空闲沙箱。
- [ ] **身份链正确**：`kubectl -n tinyagent get agentidentity,credentialprovider,agentrole,agentrolebinding`，确认使用临时身份，不是长期 AccessKey。

## 可选的真实集成测试

只有确认费用后才运行：

```bash
TINYAGENT_BASE_URL=https://<你的域名> \
  go test -tags integration ./integration -run TestCloudChatPromptCompletes -v
```

当前测试代码可能仍依赖旧的 `done/error` 事件格式。运行前先对照 [浏览器接口约定](browser-api.md) 检查测试是否已经跟当前 ACP 协议同步；测试本身报错时，不要直接重建云资源。
