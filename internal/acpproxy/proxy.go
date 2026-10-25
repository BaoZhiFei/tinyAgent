// acpproxy 包把浏览器里的 ACP 客户端连接到沙箱中的 ACP Agent。
//
// 它只负责把两端接起来，不负责决定 ACP 对话内容：浏览器负责发送 ACP 方法、
// 接收通知、选择权限和展示界面；本包负责建立 WebSocket、领取沙箱、转发 JSON-RPC，
// 再把消息副本交给 Observer 保存。
package acpproxy

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/example/tinyagent/internal/session"
)

// Proxy 管理 ACP 连接在服务端使用的资源。ACP 方法、通知、能力和权限选择
// 仍由浏览器负责。store 用于租约和观察器持久化，sandbox 用于把 sessionID
// 映射到一台临时 Agent。
type Proxy struct {
	store         session.Store
	sandbox       Sandbox
	idleTimeout   time.Duration
	leaseDuration time.Duration
}

type ProxyOptions struct {
	IdleTimeout   time.Duration
	LeaseDuration time.Duration
}

// New 创建一个 ACP 代理。后面的处理层会在这里接上字节转发和记录功能，
// 但不会改变浏览器看到的 ACP 协议。
func New(store session.Store, sandbox Sandbox) *Proxy {
	return NewWithOptions(store, sandbox, ProxyOptions{})
}

func NewWithOptions(store session.Store, sandbox Sandbox, options ProxyOptions) *Proxy {
	leaseDuration := options.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = 10 * time.Minute
	}
	if options.IdleTimeout > 0 && leaseDuration <= options.IdleTimeout {
		leaseDuration = options.IdleTimeout + time.Minute
	}
	return &Proxy{
		store:         store,
		sandbox:       sandbox,
		idleTimeout:   options.IdleTimeout,
		leaseDuration: leaseDuration,
	}
}

// ServePrompt 把会话地址升级为 ACP WebSocket 连接。
//
// 完整模式的顺序是：先生成本次连接的标识，再锁住 session，接着领取沙箱，
// 然后才升级 WebSocket 并开始转发。连接结束时按相反顺序释放沙箱和 session 锁。
// 中间任一步失败都会返回固定的 HTTP 错误，详细原因只写日志；没有注入真实依赖时，
// 只做 WebSocket 升级检查，方便测试路由本身。
func (p *Proxy) ServePrompt(writer http.ResponseWriter, request *http.Request, sessionID string) {
	if p.store == nil || p.sandbox == nil {
		p.acceptForTransportCheck(writer, request)
		return
	}
	connection, err := websocket.Accept(writer, request, nil)
	if err != nil {
		return
	}
	defer connection.Close(websocket.StatusNormalClosure, "")
	reporter := newStatusReporter(connection)
	if err := reporter.send(request.Context(), TurnStatus{Phase: StatusPhaseConnecting, Label: "已连接服务器"}); err != nil {
		return
	}
	// 先完成 WebSocket 升级并反馈 connecting，再获取数据库租约；否则页面看到的
	// “WebSocket 握手”会错误地包含 session 锁等待时间。
	holder, err := newLeaseHolder()
	if err != nil {
		_ = reporter.send(context.Background(), TurnStatus{Phase: StatusPhaseFailed, Label: "无法连接 Agent"})
		return
	}
	lease, err := p.store.AcquireLease(request.Context(), sessionID, holder, p.leaseDuration)
	if err != nil {
		_ = reporter.send(context.Background(), TurnStatus{Phase: StatusPhaseFailed, Label: "无法连接 Agent"})
		return
	}
	// 从这里开始，无论后面领取沙箱还是连接 Agent 是否成功，都必须释放 session 锁。
	defer lease.Release(context.Background())
	agent, release, err := acquireSandbox(request.Context(), p.sandbox, sessionID, reporter.send)
	if err != nil {
		_ = reporter.send(context.Background(), TurnStatus{Phase: StatusPhaseFailed, Label: "无法连接 Agent"})
		return
	}
	// release 负责删除云端 Claim 和已经领到的 Sandbox；不能只关闭网络连接。
	defer release(context.Background())
	p.serveConnection(connection, request, sessionID, agent, reporter)
}

func acquireSandbox(ctx context.Context, provider Sandbox, sessionID string, report func(context.Context, TurnStatus) error) (io.ReadWriteCloser, func(context.Context) error, error) {
	if observable, ok := provider.(ObservableSandbox); ok {
		return observable.AcquireWithProgress(ctx, sessionID, func(progress SandboxProgress) {
			_ = report(ctx, TurnStatus{Phase: progress.Phase, Label: progress.Label, SandboxSource: progress.Source})
		})
	}
	for _, progress := range []SandboxProgress{
		{Phase: StatusPhaseSandboxClaiming, Label: "领取沙箱"},
		{Phase: StatusPhaseSandboxWaiting, Label: "等待沙箱就绪"},
		{Phase: StatusPhaseAgentConnecting, Label: "连接 Agent"},
	} {
		if err := report(ctx, TurnStatus{Phase: progress.Phase, Label: progress.Label}); err != nil {
			return nil, nil, err
		}
	}
	agent, release, err := provider.Acquire(ctx, sessionID)
	if err != nil {
		return nil, nil, err
	}
	if err := report(ctx, TurnStatus{Phase: StatusPhaseAgentReady, Label: "Agent 已连接"}); err != nil {
		_ = release(context.Background())
		return nil, nil, err
	}
	return agent, release, nil
}

func (p *Proxy) acceptForTransportCheck(writer http.ResponseWriter, request *http.Request) {
	// 这个分支不连接真实 Agent，只验证浏览器能否完成 WebSocket 升级。
	connection, err := websocket.Accept(writer, request, nil)
	if err != nil {
		return
	}
	defer connection.Close(websocket.StatusNormalClosure, "")
}

func (p *Proxy) serveConnection(connection *websocket.Conn, request *http.Request, sessionID string, agent io.ReadWriteCloser, reporter *statusReporter) {
	// Observer 与这条 WebSocket 一一对应，避免并发连接之间互相混入用户问题、回复和 session ID。
	observer := NewObserver(p.store, sessionID)
	if err := proxyACP(request.Context(), connection, agent, observer, reporter, p.idleTimeout); err != nil {
		log.Printf("ACP proxy connection ended: %v", err)
	}
	_ = observer.Finalize(context.Background())
}

type statusReporter struct {
	connection *websocket.Conn
	started    time.Time
	phaseStart time.Time
	mu         sync.Mutex
}

func newStatusReporter(connection *websocket.Conn) *statusReporter {
	now := time.Now()
	return &statusReporter{connection: connection, started: now, phaseStart: now}
}

func (r *statusReporter) send(ctx context.Context, status TurnStatus) error {
	now := time.Now()
	status.ElapsedMs, status.TotalElapsedMs = statusTimings(r.started, r.phaseStart, now)
	payload := struct {
		JSONRPC string       `json:"jsonrpc"`
		Method  string       `json:"method"`
		Params  publicStatus `json:"params"`
	}{JSONRPC: "2.0", Method: "tinyagent/status", Params: publicStatusPayload(status)}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if err := r.write(ctx, websocket.MessageText, encoded); err != nil {
		return err
	}
	if status.Phase != "" {
		r.phaseStart = now
	}
	return nil
}

func (r *statusReporter) write(ctx context.Context, messageType websocket.MessageType, payload []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connection.Write(ctx, messageType, payload)
}

func statusTimings(started, phaseStarted, now time.Time) (int64, int64) {
	return now.Sub(phaseStarted).Milliseconds(), now.Sub(started).Milliseconds()
}

func newLeaseHolder() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

// proxyACP 只转换传输层的分隔方式：浏览器使用 WebSocket 文本消息，ACP Agent
// 使用以换行分隔的 JSON-RPC 字节流。它不会校验、解析或改写 ACP 文档。
//
// 两个后台任务分别负责浏览器→Agent 和 Agent→浏览器；任一方向结束都会取消
// 另一个方向，关闭所有连接，最后等待另一个任务退出，避免留下后台读写。
func proxyACP(ctx context.Context, browser *websocket.Conn, agent io.ReadWriteCloser, observer documentObserver, reporter *statusReporter, idleTimeout time.Duration) error {
	// WebSocket 一端用“消息”传输，Agent 一端用“换行”分隔字节流；这里只转换外层包装，
	// ACP 文档本身保持原样。两个方向各自读取和写入，任一方向出错都会收掉整个连接。
	browser.SetReadLimit(1 << 20)
	proxyContext, cancel := context.WithCancel(ctx)
	defer cancel()
	defer agent.Close()
	defer browser.Close(websocket.StatusNormalClosure, "")

	errors := make(chan error, 2)
	activity := make(chan struct{}, 1)
	lifecycle := &acpLifecycle{}
	notifyActivity := func() {
		select {
		case activity <- struct{}{}:
		default:
		}
	}
	writeBrowser := func(writeContext context.Context, payload []byte) error {
		if reporter != nil {
			return reporter.write(writeContext, websocket.MessageText, payload)
		}
		return browser.Write(writeContext, websocket.MessageText, payload)
	}
	go func() {
		for {
			// 浏览器每条 ACP 文档都是一条 WebSocket 文本消息；Agent 端需要换行作为分隔符。
			messageType, payload, err := browser.Read(proxyContext)
			if err != nil {
				errors <- err
				return
			}
			if messageType != websocket.MessageText {
				errors <- fmt.Errorf("ACP WebSocket message is not text")
				return
			}
			notifyActivity()
			lifecycle.observeClient(proxyContext, payload, reporter)
			if observer != nil {
				observer.ObserveClient(append([]byte(nil), payload...))
			}
			frame := make([]byte, len(payload)+1)
			copy(frame, payload)
			frame[len(payload)] = '\n'
			if _, err := agent.Write(frame); err != nil {
				errors <- err
				return
			}
		}
	}()
	go func() {
		reader := bufio.NewReader(agent)
		for {
			// ACP Agent 输出以换行分隔的 JSON-RPC；去掉分隔换行后原样交给浏览器。
			frame, err := reader.ReadBytes('\n')
			if err != nil {
				errors <- err
				return
			}
			payload := frame[:len(frame)-1]
			notifyActivity()
			if observer != nil {
				if err := observer.ObserveAgent(proxyContext, append([]byte(nil), payload...)); err != nil {
					errors <- err
					return
				}
			}
			lifecycle.observeAgent(proxyContext, payload, reporter)
			if err := writeBrowser(proxyContext, payload); err != nil {
				errors <- err
				return
			}
		}
	}()

	stop := func(err error) error {
		cancel()
		_ = agent.Close()
		_ = browser.Close(websocket.StatusNormalClosure, "")
		<-errors
		return err
	}
	if idleTimeout <= 0 {
		return stop(<-errors)
	}
	timer := time.NewTimer(idleTimeout)
	defer timer.Stop()
	for {
		select {
		case err := <-errors:
			return stop(err)
		case <-activity:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(idleTimeout)
		case <-timer.C:
			return stop(fmt.Errorf("ACP connection idle timeout"))
		}
	}
}

type acpLifecycle struct {
	mu                sync.Mutex
	initializeRequest string
	sessionRequest    string
}

func (l *acpLifecycle) observeClient(ctx context.Context, payload []byte, reporter *statusReporter) {
	if reporter == nil {
		return
	}
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if json.Unmarshal(payload, &message) != nil || len(message.ID) == 0 {
		return
	}
	id := string(message.ID)
	l.mu.Lock()
	defer l.mu.Unlock()
	switch message.Method {
	case "initialize":
		l.initializeRequest = id
		_ = reporter.send(ctx, TurnStatus{Phase: StatusPhaseACPInitializing, Label: "正在执行 ACP initialize"})
	case "session/new", "session/load":
		l.sessionRequest = id
		_ = reporter.send(ctx, TurnStatus{Phase: StatusPhaseACPSessionInitializing, Label: "正在创建或恢复 ACP session"})
	}
}

func (l *acpLifecycle) observeAgent(ctx context.Context, payload []byte, reporter *statusReporter) {
	if reporter == nil {
		return
	}
	var message struct {
		ID json.RawMessage `json:"id"`
	}
	if json.Unmarshal(payload, &message) != nil || len(message.ID) == 0 {
		return
	}
	id := string(message.ID)
	l.mu.Lock()
	defer l.mu.Unlock()
	switch id {
	case l.initializeRequest:
		_ = reporter.send(ctx, TurnStatus{Phase: StatusPhaseACPSessionInitializing, Label: "正在创建或恢复 ACP session"})
	case l.sessionRequest:
		_ = reporter.send(ctx, TurnStatus{Phase: StatusPhaseACPReady, Label: "ACP session 已就绪"})
	}
}
