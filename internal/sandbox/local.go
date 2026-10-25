// 本文件是 Docker Compose 下的本地替代实现：不创建 Claim、不访问 Kubernetes，
// 只连接一个已经启动好的 ACP bridge，方便本地检查完整的转发流程。
package sandbox

import (
	"context"
	"fmt"
	"io"
	"net/url"

	"github.com/example/tinyagent/internal/acpproxy"

	"github.com/coder/websocket"
)

func localProgressPhases() []acpproxy.SandboxProgress {
	return []acpproxy.SandboxProgress{
		{Phase: acpproxy.StatusPhaseAgentConnecting, Label: "连接本地 Agent", Source: acpproxy.SandboxSourceLocal},
		{Phase: acpproxy.StatusPhaseAgentReady, Label: "本地 Agent 已连接", Source: acpproxy.SandboxSourceLocal},
	}
}

// LocalManager 把 API 连接到 Docker Compose 中的本地 ACP bridge。
// 本地模式没有云资源要回收，所以 release 只负责关闭这条连接。
type LocalManager struct{ endpoint string }

// NewLocalManager 校验本地桥地址，并返回可注入 ACP 代理的 Sandbox 实现。
func NewLocalManager(endpoint string) (*LocalManager, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.Host == "" {
		return nil, fmt.Errorf("invalid local ACP endpoint %q", endpoint)
	}
	return &LocalManager{endpoint: endpoint}, nil
}

func (m *LocalManager) Acquire(ctx context.Context, _ string) (io.ReadWriteCloser, func(context.Context) error, error) {
	return m.AcquireWithProgress(ctx, "", nil)
}

func (m *LocalManager) AcquireWithProgress(ctx context.Context, _ string, report func(acpproxy.SandboxProgress)) (io.ReadWriteCloser, func(context.Context) error, error) {
	reportProgress(report, acpproxy.SandboxProgress{Phase: acpproxy.StatusPhaseAgentConnecting, Label: "连接本地 Agent", Source: acpproxy.SandboxSourceLocal})
	// 本地模式不需要 sessionID 来找资源；参数仍保留，是因为云端和本地要共用 Sandbox 接口。
	connection, _, err := websocket.Dial(ctx, m.endpoint, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("dial local ACP endpoint: %w", err)
	}
	stream := websocket.NetConn(ctx, connection, websocket.MessageBinary)
	reportProgress(report, acpproxy.SandboxProgress{Phase: acpproxy.StatusPhaseAgentReady, Label: "本地 Agent 已连接", Source: acpproxy.SandboxSourceLocal})
	return stream, func(context.Context) error { return stream.Close() }, nil
}
