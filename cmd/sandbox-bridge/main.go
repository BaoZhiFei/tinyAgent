// Command sandbox-bridge 把 ACK 沙箱外的 WebSocket 连接原样接到内部 codex-acp 进程的标准输入输出。
// 它不理解 ACP 内容；这样协议升级时只需升级 Codex，而无需改这层“电话线转门缝”的桥。
package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const mountPollInterval = 100 * time.Millisecond

func main() {
	// AGENT_CMD 由镜像或部署环境注入，通常是 codex-acp。桥接程序不替它设置默认值，
	// 因为启动了错误命令时，浏览器看到的会是一个看似连通但永远不会回答的 Agent。
	command := agentCommand()
	if command == "" {
		log.Fatal("AGENT_CMD is required")
	}
	// HTTP server 只负责接受一条内部 WebSocket 连接；每条连接都会在
	// handleConnection 中启动一个独立的 Agent 子进程。
	server := newBridgeServer(command)
	log.Printf("sandbox bridge listening on %s", bridgeAddress())
	log.Fatal(server.ListenAndServe())
}

// bridgeAddress 返回业务桥监听的地址。
//
// BRIDGE_ADDR 允许本地 Compose 或其他运行环境改端口；默认的 8080 是后端
// Sandbox Manager 连接的业务端口。ACK agent-runtime 使用的是另一个专用端口
// 49983，不能把这两个端口混用。
func bridgeAddress() string {
	if address := os.Getenv("BRIDGE_ADDR"); address != "" {
		return address
	}
	return ":8080"
}

// agentCommand 返回需要由每条 WebSocket 连接启动的 ACP Agent 命令。
func agentCommand() string { return os.Getenv("AGENT_CMD") }

// newBridgeServer 创建只注册一个根路径的桥接 HTTP 服务。
//
// 这里不增加 JSON API 或健康检查响应，因为这个端口的唯一职责是把后端的
// WebSocket 接到 ACP 进程；普通日志也不能写入 ACP 数据流。
func newBridgeServer(command string) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) { handleConnection(writer, request, command) })
	return &http.Server{Addr: bridgeAddress(), Handler: mux}
}

// handleConnection 把一条 WebSocket 连接绑定到一个 Agent 子进程。
//
// WebSocket 的二进制消息会通过 websocket.NetConn 变成进程的标准输入输出，
// 因此桥接层不会解析、重编码或记录 ACP JSON-RPC。请求 context 取消时，
// CommandContext 会终止子进程，避免浏览器断开后沙箱里残留 Agent。
func handleConnection(writer http.ResponseWriter, request *http.Request, command string) {
	var waitMounts func() error
	if os.Getenv("REQUIRE_AGENTICFS_MOUNTS") == "1" {
		waitMounts = func() error {
			return waitForMounts(30*time.Second, "/home/agent/workspace", "/home/agent/.codex/sessions")
		}
	}
	handleConnectionWithMountWait(writer, request, command, waitMounts)
}

func handleConnectionWithMountWait(writer http.ResponseWriter, request *http.Request, command string, waitMounts func() error) {
	connection, err := websocket.Accept(writer, request, nil)
	if err != nil {
		return
	}
	defer connection.Close(websocket.StatusNormalClosure, "")
	if waitMounts != nil {
		if err := waitMounts(); err != nil {
			log.Printf("AgenticFS mounts are not ready: %v", err)
			return
		}
	}
	context, cancel := context.WithCancel(request.Context())
	defer cancel()
	// ACP 使用标准输入输出传输；这里选择二进制 WebSocket 消息，避免 WebSocket
	// 文本层对字节内容做任何额外假设。上游 acpproxy 负责浏览器文本消息与此处
	// 字节流之间的外层转换。
	stream := websocket.NetConn(context, connection, websocket.MessageBinary)
	process := exec.CommandContext(context, command)
	process.Stdin = stream
	process.Stdout = stream
	process.Stderr = os.Stderr
	if err := process.Start(); err != nil {
		log.Printf("start agent: %v", err)
		return
	}
	// Wait 必须在这里执行，既回收子进程资源，也能记录 Agent 自己退出的原因。
	// 如果是请求取消导致的退出，属于正常收尾，不再重复打印错误。
	// Codex 退出、或浏览器断开，另一端都会随着 context 取消收尾。这里不把 stderr
	// 混入 ACP 流，否则任何诊断文字都会破坏 JSON-RPC 报文。
	if err := process.Wait(); err != nil && context.Err() == nil {
		log.Printf("agent exited: %v", err)
	}
	_ = stream.Close()
}

// waitForMounts 等待动态挂载的 AgenticFS 目录真正出现在桥接进程里。
// 预热池里的沙箱故意还没有挂载这些目录，所以检查必须发生在收到连接、
// SandboxClaim 已经完成挂载之后，不能在进程启动时过早检查。
func waitForMounts(timeout time.Duration, paths ...string) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(mountPollInterval)
	defer ticker.Stop()
	for {
		mountInfo, err := os.Open("/proc/self/mountinfo")
		if err == nil {
			checkErr := requireMounts(mountInfo, resolveMountPaths(paths)...)
			_ = mountInfo.Close()
			if checkErr == nil {
				return nil
			}
		}
		select {
		case <-deadline.C:
			if err != nil {
				return fmt.Errorf("read mount info: %w", err)
			}
			return fmt.Errorf("required mount is missing")
		case <-ticker.C:
		}
	}
}

// resolveMountPaths 跟着 Sandbox CSI overlay 创建的软链接找到真实目录。
// 程序配置里看到的是软链接路径，而 Linux 的 mountinfo 记录的是链接指向的
// 真实路径；两边必须先统一，后面的挂载检查才不会误报。
func resolveMountPaths(paths []string) []string {
	resolved := make([]string, len(paths))
	for index, path := range paths {
		resolved[index] = path
		if target, err := filepath.EvalSymlinks(path); err == nil {
			resolved[index] = target
		}
	}
	return resolved
}

// requireMounts 读取 Linux 的 mountinfo，确认每个必需目录都已经挂载。
// 它和 waitForMounts 分开，是为了可以用一段普通文本测试挂载规则，
// 不必启动特权容器或连接真实 AgenticFS。
func requireMounts(reader io.Reader, paths ...string) error {
	wanted := make(map[string]bool, len(paths))
	for _, path := range paths {
		wanted[path] = false
	}
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 {
			continue
		}
		if _, ok := wanted[fields[4]]; ok {
			wanted[fields[4]] = true
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	for path, found := range wanted {
		if !found {
			return fmt.Errorf("mount %s is missing", path)
		}
	}
	return nil
}
