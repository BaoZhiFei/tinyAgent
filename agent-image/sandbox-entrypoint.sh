#!/bin/sh
# AgenticFS 的动态挂载由运行时携带 root 身份的访问凭据。虽然挂载点显示为 777，普通
# Linux 用户仍会被服务端拒绝写入；启动后再 chown 也不能改变这条服务端规则。这里必须让
# bridge 与 Codex 保持 root 身份，才能把 rollout 写回 AgenticFS。仍显式把 HOME 指到挂载
# 路径的父目录：root 默认的 /root/.codex 没有被挂载，若用它就会把“可写”变成“不可恢复”。
# root 仅存在于阿里云隔离沙箱内部，并不拥有 ACK 集群或宿主机权限。Shell 作为 PID 1 还负责
# 可靠传递停止信号。
set -eu
mkdir -p /home/agent/workspace /home/agent/.codex/sessions
# Codex 仅在启动时从 config.toml 读取 model_catalog_json；ACP 会话的 CODEX_CONFIG
# 不会加载它。此目录由 AgenticFS/Compose 卷持久化，故每次启动均幂等写入，既保证
# 升级目录路径后生效，也不覆盖其它 Codex 配置。
if [ "${MODEL_PROVIDER}" = "bailian" ]; then
  codex_config=/home/agent/.codex/config.toml
  catalog_path=/usr/local/share/tinyagent/bailian-model-catalog.json
  if [ -f "$codex_config" ] && grep -q '^[[:space:]]*model_catalog_json[[:space:]]*=' "$codex_config"; then
    sed -i "s|^[[:space:]]*model_catalog_json[[:space:]]*=.*|model_catalog_json = \"$catalog_path\"|" "$codex_config"
  else
    printf '\nmodel_catalog_json = "%s"\n' "$catalog_path" >> "$codex_config"
  fi
fi
export HOME=/home/agent
exec sandbox-bridge
