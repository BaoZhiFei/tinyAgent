# 本地检查：先确认代码，再碰云端

本页的普通检查只在电脑上运行，不登录阿里云，也不需要模型密钥。最后的“本地真实 Agent”例外：它会调用百炼模型并产生模型费用，但不会创建阿里云云资源。

## 需要准备

- Go 1.24；
- Node.js 22 或兼容版本；
- Git 和 `make`；
- Docker Desktop（只有运行本地真实 Agent 时需要）。

第一次进入项目时安装项目已经声明的依赖：

```bash
npm ci --prefix web
npm ci --prefix infra
```

这只是下载测试和构建工具，不会发布代码。

## 最常用的检查

在项目根目录运行：

```bash
make verify
```

它会检查 Go 格式和测试、网页测试和构建、infra TypeScript 构建。退出码为 `0` 且没有 `FAIL`，才算通过。

只改一层时可以先跑局部检查：

| 改动 | 命令 |
| --- | --- |
| Go | `go test ./...` |
| 网页 | `cd web && npm test -- --run && npm run build` |
| infra | `cd infra && npm run build` |

局部检查通过后，仍要回到根目录跑 `make verify`，因为模块之间有接口约定。

## 本地真实 Agent（会产生模型费用）

这一步会在 Docker 里启动 PostgreSQL、Go API、网页和一个本地 Sandbox，并让其中的 Codex 调用百炼。它不会创建阿里云资源，但会消耗模型额度。

```bash
export DASHSCOPE_API_KEY='你的密钥'
docker compose up --build -d
```

打开 `http://localhost:8080`，发送一句短问题，确认：回答会逐步出现、ACP 活动能显示、权限请求能处理。页面只绑定 `127.0.0.1`，不要把带真实密钥的本地服务暴露给局域网。

结束时使用：

```bash
docker compose down
```

不要加 `--volumes`，否则 PostgreSQL 历史和本地 Codex 会话文件会一起删除。下次重新 `up` 可以继续使用这些本地卷。

## 本地和云端的区别

本地模式用 Docker Sandbox 和 `LOCAL_ACP_ENDPOINT`；云端模式用 ACK 的 `SandboxClaim` 和 ServiceAccount。不要把本地的 Docker 地址、kubeconfig 或模型密钥写进云端配置。
