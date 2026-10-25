// 本文件只负责穿过 Sandbox 边界连接业务容器里的 ACP bridge。
// 它不创建、不删除 Kubernetes 资源，资源的领取和回收由 kubernetes.go 负责。
package sandbox

import (
	"context"
	"fmt"
	"io"
	"net"

	"github.com/coder/websocket"
)

// DialBridge 连接业务容器固定监听 8080 端口的桥，并把 WebSocket 包装成普通双向字节流。
// 49983 端口属于 ACK agent-runtime，用来处理挂载和命令管理，不能拿来传 ACP。
// 上层 ACP 代码只需要一根像 stdin/stdout 一样的流，不需要知道中间经过了 WebSocket。
func DialBridge(ctx context.Context, sandboxIP string) (io.ReadWriteCloser, error) {
	if sandboxIP == "" {
		return nil, fmt.Errorf("sandbox IP is empty")
	}
	connection, _, err := websocket.Dial(ctx, "ws://"+net.JoinHostPort(sandboxIP, "8080")+"/", nil)
	if err != nil {
		return nil, fmt.Errorf("dial sandbox bridge: %w", err)
	}
	return websocket.NetConn(ctx, connection, websocket.MessageBinary), nil
}
