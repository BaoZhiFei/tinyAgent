// sandbox 包负责向 ACK 的阿里云 Sandbox 预热池领取、挂载和回收隔离环境。
//
// 本包把 Kubernetes 资源细节藏在 Manager 后面：上层只关心一根能给 ACP 使用的
// 双向字节流，以及一个无论成功失败都必须调用的 release 函数。
package sandbox

import (
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

const (
	// agentIdentityName 是 ACK Agent Identity 中代表 tinyAgent 的身份名称。
	// 沙箱本身不用长期 RAM 密钥；运行时会用这个名字向集群索取一次性的挂载凭据。
	agentIdentityName = "tinyagent-storage-agent"
	// credentialProviderName 是允许 AgenticFS 读写的凭据提供者。
	// 两个挂载都复用它，权限范围则由基础设施中的 RAM 策略限制到本项目的 AccessPoint。
	credentialProviderName = "agenticfs-read-write"
)

// BuildClaim 只组装领取沙箱所需的描述，不会真的向 Kubernetes 创建资源。
// 真正创建由 Manager.Acquire 完成。
//
// workspace 保存用户任务产生的工作文件，codex-sessions 保存 Codex 恢复上下文的
// 会话文件。它们必须分别挂载到两个目录，不能把整个持久卷覆盖到镜像的 home 目录，
// 否则可能遮住镜像自带的 Codex 配置和启动文件。
func BuildClaim(namespace, poolName, sessionID, persistentVolumeName, timeout string, maxLifetime time.Duration) (*unstructured.Unstructured, error) {
	if !validName(sessionID) {
		return nil, fmt.Errorf("invalid session id %q", sessionID)
	}
	if maxLifetime <= 0 {
		return nil, fmt.Errorf("max lifetime must be positive")
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "agents.kruise.io/v1alpha1", "kind": "SandboxClaim",
		"metadata": map[string]any{
			"name":      "tinyagent-" + sessionID,
			"namespace": namespace,
		},
		"spec": map[string]any{"templateName": poolName, "replicas": int64(1), "claimTimeout": timeout,
			// 这是挂载 AgenticFS 的“工作证”。必须放在 spec.annotations，控制器才会把它
			// 复制到被领取的 Sandbox；写在 Claim 自己的 metadata 中不会参与领取流程。
			"annotations": map[string]any{"security.agents.kruise.io/agent-name": agentIdentityName},
			// 动态挂载会让预热沙箱做一次原地更新。默认 30 秒常常短于镜像、CSI 和
			// AgenticFS 凭据就绪所需时间，控制器会误判失败并反复回收重建；等待上限必须
			// 至少覆盖整张领取单的生命周期，才不会把“正在启动”当成“永远启动不了”。
			"waitReadyTimeout": timeout,
			"shutdownTime":     time.Now().Add(maxLifetime).UTC().Format(time.RFC3339),
			"dynamicVolumesMount": []any{
				map[string]any{"pvName": persistentVolumeName, "mountPath": "/home/agent/workspace", "subPath": "workspace/" + sessionID, "attributes": map[string]any{"credentialProviderName": credentialProviderName}},
				map[string]any{"pvName": persistentVolumeName, "mountPath": "/home/agent/.codex/sessions", "subPath": "codex-sessions/" + sessionID, "attributes": map[string]any{"credentialProviderName": credentialProviderName}},
			},
		},
	}}, nil
}

func validName(value string) bool {
	// sessionID 会直接拼进 Kubernetes 资源名和 AgenticFS subPath，不能包含斜杠、空格等字符。
	// 限制长度是为了给 tinyagent- 前缀留出空间，同时保证各组件都能接受这个名字。
	if value == "" || len(value) > 52 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return !strings.HasPrefix(value, "-") && !strings.HasSuffix(value, "-")
}
