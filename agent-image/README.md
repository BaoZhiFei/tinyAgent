# 沙箱镜像

这份镜像是每台阿里云 Sandbox 使用的“小电脑模板”。它只负责两件事：启动 `codex-acp`，以及启动 `sandbox-bridge`。

## 每个程序做什么

- `codex-acp`：真正接收问题、调用模型、保存 AI 会话记忆的程序。
- `sandbox-bridge`：电话接线员。它把后端打进来的 WebSocket 数据原样转给 `codex-acp` 的标准输入输出，不分析 ACP 内容。

桥不能放在 Go 后端里，因为后端和 Codex 分别在集群和隔离沙箱两边。桥的存在让两边能安全通话，而不必把沙箱内部端口暴露给浏览器。

## 密钥在哪里

模型 API Key、模型地址和 `CODEX_CONFIG` 都不在镜像中。云端 `SandboxSet` 从 Kubernetes Secret 注入它们；本地 Compose 从启动 shell 的 `DASHSCOPE_API_KEY` 注入百炼 Qwen3.8-Max 凭据。把密钥烤进镜像，会让每个能拉到镜像的人都可能拿到密钥。

## 为什么这里使用 root

`sandbox-entrypoint.sh` 是容器的一号进程，负责把停止信号传给桥和 Codex。AgenticFS 的动态挂载使用 root 身份的临时授权；即使目录看起来可写，普通 Linux 用户也会被服务端拒绝。因此桥和 Codex 必须保留 root 身份，才能把会话文件写回挂载目录。

脚本仍把 `HOME` 明确设为 `/home/agent`：这样 Codex 使用被挂载的 `/home/agent/.codex/sessions`，而不是不会持久化的 `/root/.codex`。这里的 root 只存在于隔离沙箱内，不拥有 ACK 集群或宿主机权限。
