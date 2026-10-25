// 这些测试确认 WebSocket 升级、消息分隔方式以及连接关闭后的资源回收符合约定。
package acpproxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/example/tinyagent/internal/session"
)

func TestServeHTTPAcceptsWebSocket(t *testing.T) {
	// 没有注入真实资源时，代理仍应能完成传输层升级检查。
	proxy := New(nil, nil)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		proxy.ServePrompt(writer, request, "session-1")
	}))
	defer server.Close()

	address := "ws" + strings.TrimPrefix(server.URL, "http")
	connection, _, err := websocket.Dial(context.Background(), address, nil)
	if err != nil {
		t.Fatalf("dial ACP proxy: %v", err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "")
}

func TestServeHTTPRejectsForeignWebSocketOrigin(t *testing.T) {
	// 不允许任意网站借助浏览器连接真实 Agent。
	proxy := New(nil, nil)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		proxy.ServePrompt(writer, request, "session-1")
	}))
	defer server.Close()

	address := "ws" + strings.TrimPrefix(server.URL, "http")
	connection, response, err := websocket.Dial(context.Background(), address, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://untrusted.example"}},
	})
	if connection != nil {
		_ = connection.Close(websocket.StatusNormalClosure, "")
	}
	if err == nil {
		t.Fatal("foreign-origin WebSocket dial unexpectedly succeeded")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		got := 0
		if response != nil {
			got = response.StatusCode
		}
		t.Fatalf("foreign-origin status = %d, want %d", got, http.StatusForbidden)
	}
}

type countingLease struct {
	session.Lease
	released *int
}

func (l countingLease) Release(ctx context.Context) error { *l.released++; return l.Lease.Release(ctx) }

type countingStore struct {
	session.Store
	releases int
}

type delayedLeaseStore struct {
	session.Store
	started chan struct{}
	release chan struct{}
}

func (s *delayedLeaseStore) AcquireLease(ctx context.Context, id, holder string, duration time.Duration) (session.Lease, error) {
	close(s.started)
	select {
	case <-s.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return s.Store.AcquireLease(ctx, id, holder, duration)
}

func TestProxyReportsConnectionBeforeSessionLeaseFinishes(t *testing.T) {
	base := session.NewMemoryStore()
	record, err := base.CreateSession(context.Background(), "delayed lease")
	if err != nil {
		t.Fatal(err)
	}
	store := &delayedLeaseStore{Store: base, started: make(chan struct{}), release: make(chan struct{})}
	proxy := New(store, &observableSandbox{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		proxy.ServePrompt(writer, request, record.ID)
	}))
	defer server.Close()

	dialContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(dialContext, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial ACP proxy: %v", err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "done")
	select {
	case <-store.started:
	case <-time.After(time.Second):
		t.Fatal("session lease did not start")
	}
	readContext, readCancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer readCancel()
	_, payload, err := connection.Read(readContext)
	if err != nil {
		t.Fatalf("read connection status before lease release: %v", err)
	}
	var message struct {
		Params struct {
			Phase string `json:"phase"`
		} `json:"params"`
	}
	if err := json.Unmarshal(payload, &message); err != nil {
		t.Fatal(err)
	}
	if message.Params.Phase != "connecting" {
		t.Fatalf("first phase = %q, want connecting", message.Params.Phase)
	}
	close(store.release)
}

func (s *countingStore) AcquireLease(ctx context.Context, id, holder string, duration time.Duration) (session.Lease, error) {
	lease, err := s.Store.AcquireLease(ctx, id, holder, duration)
	if err != nil {
		return nil, err
	}
	return countingLease{Lease: lease, released: &s.releases}, nil
}

type countingSandbox struct {
	peer     net.Conn
	releases int
	mutex    sync.Mutex
}

type observableSandbox struct {
	released int
}

type failingObservableSandbox struct{}

func (failingObservableSandbox) Acquire(context.Context, string) (io.ReadWriteCloser, func(context.Context) error, error) {
	return nil, nil, errors.New("sandbox unavailable")
}

func (failingObservableSandbox) AcquireWithProgress(_ context.Context, _ string, report func(SandboxProgress)) (io.ReadWriteCloser, func(context.Context) error, error) {
	report(SandboxProgress{Phase: StatusPhaseSandboxWaiting, Label: "等待沙箱就绪", Source: SandboxSourceProvisioning})
	return nil, nil, errors.New("sandbox unavailable")
}

func (s *observableSandbox) Acquire(context.Context, string) (io.ReadWriteCloser, func(context.Context) error, error) {
	return s.AcquireWithProgress(context.Background(), "", nil)
}

func (s *observableSandbox) AcquireWithProgress(_ context.Context, _ string, report func(SandboxProgress)) (io.ReadWriteCloser, func(context.Context) error, error) {
	proxy, peer := net.Pipe()
	for _, progress := range []SandboxProgress{
		{Phase: StatusPhaseSandboxClaiming, Label: "领取沙箱", Source: SandboxSourceWarmPool},
		{Phase: StatusPhaseSandboxWaiting, Label: "等待沙箱就绪", Source: SandboxSourceWarmPool},
		{Phase: StatusPhaseAgentConnecting, Label: "连接 Agent", Source: SandboxSourceWarmPool},
		{Phase: StatusPhaseAgentReady, Label: "Agent 已连接", Source: SandboxSourceWarmPool},
	} {
		if report != nil {
			report(progress)
		}
	}
	return proxy, func(context.Context) error { s.released++; return peer.Close() }, nil
}

func TestProxyStreamsLifecycleStatusesBeforeAgentReady(t *testing.T) {
	base := session.NewMemoryStore()
	record, err := base.CreateSession(context.Background(), "status")
	if err != nil {
		t.Fatal(err)
	}
	sandbox := &observableSandbox{}
	proxy := New(base, sandbox)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		proxy.ServePrompt(writer, request, record.ID)
	}))
	defer server.Close()
	connection, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "done")

	want := []string{"connecting", "sandbox_claiming", "sandbox_waiting", "agent_connecting", "agent_ready"}
	readContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for index, phase := range want {
		_, payload, err := connection.Read(readContext)
		if err != nil {
			t.Fatalf("read status %d: %v", index, err)
		}
		var message struct {
			Method string `json:"method"`
			Params struct {
				Phase string `json:"phase"`
			} `json:"params"`
		}
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatal(err)
		}
		if message.Method != "tinyagent/status" || message.Params.Phase != phase {
			t.Fatalf("status[%d] = %s/%s, want %s", index, message.Method, message.Params.Phase, phase)
		}
	}
}

func TestProxyStreamsFailureStatusWhenSandboxCannotBeAcquired(t *testing.T) {
	base := session.NewMemoryStore()
	record, err := base.CreateSession(context.Background(), "failure")
	if err != nil {
		t.Fatal(err)
	}
	proxy := New(base, failingObservableSandbox{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		proxy.ServePrompt(writer, request, record.ID)
	}))
	defer server.Close()
	connection, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "done")
	readContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var phases []string
	for len(phases) < 3 {
		_, payload, readErr := connection.Read(readContext)
		if readErr != nil {
			t.Fatal(readErr)
		}
		var message struct {
			Params struct {
				Phase string `json:"phase"`
			} `json:"params"`
		}
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatal(err)
		}
		phases = append(phases, message.Params.Phase)
	}
	if want := []string{"connecting", "sandbox_waiting", "failed"}; !reflect.DeepEqual(phases, want) {
		t.Fatalf("phases = %#v, want %#v", phases, want)
	}
}

func (s *countingSandbox) Acquire(context.Context, string) (io.ReadWriteCloser, func(context.Context) error, error) {
	proxy, peer := net.Pipe()
	s.peer = peer
	return proxy, func(context.Context) error { s.mutex.Lock(); defer s.mutex.Unlock(); s.releases++; return peer.Close() }, nil
}

func TestProxyReleasesLeaseAndSandboxWhenBrowserCloses(t *testing.T) {
	// 浏览器主动断开后，session 锁和沙箱都必须释放，不能留在占用状态。
	base := session.NewMemoryStore()
	record, err := base.CreateSession(context.Background(), "test")
	if err != nil {
		t.Fatal(err)
	}
	store := &countingStore{Store: base}
	sandbox := &countingSandbox{}
	proxy := New(store, sandbox)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { proxy.ServePrompt(writer, request, record.ID) }))
	defer server.Close()
	connection, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(websocket.StatusNormalClosure, "done"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		sandbox.mutex.Lock()
		released := sandbox.releases
		sandbox.mutex.Unlock()
		if released == 1 && store.releases == 1 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("releases = lease:%d sandbox:%d", store.releases, sandbox.releases)
}

type idleAgent struct {
	closed chan struct{}
	once   sync.Once
}

func (a *idleAgent) Read([]byte) (int, error) {
	<-a.closed
	return 0, io.EOF
}

func (a *idleAgent) Write(payload []byte) (int, error) { return len(payload), nil }

func (a *idleAgent) Close() error {
	a.once.Do(func() { close(a.closed) })
	return nil
}

type idleSandbox struct {
	mu       sync.Mutex
	releases int
}

func (s *idleSandbox) Acquire(context.Context, string) (io.ReadWriteCloser, func(context.Context) error, error) {
	agent := &idleAgent{closed: make(chan struct{})}
	return agent, func(context.Context) error {
		s.mu.Lock()
		s.releases++
		s.mu.Unlock()
		return agent.Close()
	}, nil
}

func TestProxyReclaimsIdleConnection(t *testing.T) {
	base := session.NewMemoryStore()
	record, err := base.CreateSession(context.Background(), "idle")
	if err != nil {
		t.Fatal(err)
	}
	sandbox := &idleSandbox{}
	proxy := NewWithOptions(base, sandbox, ProxyOptions{IdleTimeout: 30 * time.Millisecond})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		proxy.ServePrompt(writer, request, record.ID)
	}))
	defer server.Close()
	connection, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "done")

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		sandbox.mu.Lock()
		released := sandbox.releases
		sandbox.mu.Unlock()
		if released == 1 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("idle connection did not release sandbox")
}

func TestProxyIdleActivityRefreshesTimeout(t *testing.T) {
	base := session.NewMemoryStore()
	record, err := base.CreateSession(context.Background(), "idle activity")
	if err != nil {
		t.Fatal(err)
	}
	sandbox := &idleSandbox{}
	proxy := NewWithOptions(base, sandbox, ProxyOptions{IdleTimeout: 50 * time.Millisecond})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		proxy.ServePrompt(writer, request, record.ID)
	}))
	defer server.Close()
	connection, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "done")

	for range 3 {
		if err := connection.Write(context.Background(), websocket.MessageText, []byte(`{"jsonrpc":"2.0","method":"initialize"}`)); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	sandbox.mu.Lock()
	released := sandbox.releases
	sandbox.mu.Unlock()
	if released != 0 {
		t.Fatalf("sandbox released while active: %d", released)
	}
}

func TestProxyACPFramingWritesBrowserDocumentWithNewline(t *testing.T) {
	// 浏览器的一条 WebSocket 文本消息要变成 Agent 能读取的一行 JSON-RPC。
	agentProxy, agentPeer := net.Pipe()
	defer agentPeer.Close()
	browser, stop := startProxyACP(t, agentProxy)
	defer stop()
	defer browser.Close(websocket.StatusNormalClosure, "")

	payload := []byte(`{"jsonrpc":"2.0","method":"initialize","params":{}}`)
	if err := browser.Write(context.Background(), websocket.MessageText, payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload)+1)
	if _, err := io.ReadFull(agentPeer, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload)+"\n" {
		t.Fatalf("agent input = %q, want %q", got, string(payload)+"\n")
	}
}

func TestProxyACPFramingReturnsCompleteAgentDocumentsUnchanged(t *testing.T) {
	// Agent 的每一行应原样作为浏览器的一条文本消息返回，代理不能改写内容。
	agentProxy, agentPeer := net.Pipe()
	defer agentPeer.Close()
	browser, stop := startProxyACP(t, agentProxy)
	defer stop()
	defer browser.Close(websocket.StatusNormalClosure, "")

	first := `{"jsonrpc":"2.0","method":"session/update","params":{}}`
	second := `this is not JSON-RPC`
	go func() {
		_, _ = io.WriteString(agentPeer, first+"\n"+second+"\n")
	}()
	for _, want := range []string{first, second} {
		_, got, err := browser.Read(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Fatalf("browser message = %q, want %q", got, want)
		}
	}
}

func TestProxyACPFramingWaitsForAgentDocumentNewline(t *testing.T) {
	// Agent 没写完一行前，浏览器不能提前收到半条 JSON-RPC。
	agentProxy, agentPeer := net.Pipe()
	defer agentPeer.Close()
	browser, stop := startProxyACP(t, agentProxy)
	defer stop()
	defer browser.Close(websocket.StatusNormalClosure, "")

	partialConsumed := make(chan struct{})
	go func() {
		_, _ = io.WriteString(agentPeer, `{"jsonrpc":"2.0"`)
		close(partialConsumed)
	}()
	<-partialConsumed
	go func() { _, _ = io.WriteString(agentPeer, `}`+"\n") }()
	_, got, err := browser.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"jsonrpc":"2.0"}` {
		t.Fatalf("browser message = %q", got)
	}
}

func startProxyACP(t *testing.T, agent io.ReadWriteCloser) (*websocket.Conn, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close(websocket.StatusNormalClosure, "")
		_ = proxyACP(request.Context(), connection, agent, nil, nil, 0)
	}))
	address := "ws" + strings.TrimPrefix(server.URL, "http")
	connection, _, err := websocket.Dial(context.Background(), address, nil)
	if err != nil {
		server.Close()
		t.Fatalf("dial ACP proxy: %v", err)
	}
	return connection, server.Close
}
