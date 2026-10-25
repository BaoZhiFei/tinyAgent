package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestMountPollIntervalIsResponsive(t *testing.T) {
	if mountPollInterval != 100*time.Millisecond {
		t.Fatalf("mount poll interval = %s, want 100ms", mountPollInterval)
	}
}

func TestBridgeAcceptsWebSocketBeforeWaitingForMounts(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		handleConnectionWithMountWait(writer, request, "cat", func() error {
			close(started)
			<-release
			return nil
		})
	}))
	defer server.Close()

	dialContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(dialContext, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatalf("bridge WebSocket was not accepted before mount wait: %v", err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "done")
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("mount wait did not start")
	}
	close(release)
}

func TestBridgeAddressUsesEnvironmentOrDefault(t *testing.T) {
	t.Setenv("BRIDGE_ADDR", "")
	if got := bridgeAddress(); got != ":8080" {
		t.Fatalf("bridgeAddress() = %q, want :8080", got)
	}
	t.Setenv("BRIDGE_ADDR", ":9090")
	if got := bridgeAddress(); got != ":9090" {
		t.Fatalf("bridgeAddress() = %q, want :9090", got)
	}
}

func TestRequiredMountsFollowSandboxSymlinks(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "run-csi", "workspace")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "home", "agent", "workspace")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	paths := resolveMountPaths([]string{link})
	canonicalTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || paths[0] != canonicalTarget {
		t.Fatalf("resolveMountPaths() = %v, want %q", paths, canonicalTarget)
	}
}

func TestRequiredMountsAreDetectedFromMountInfo(t *testing.T) {
	mountInfo := strings.NewReader(`24 19 0:22 / / rw,relatime - overlay overlay rw
25 24 0:45 /session /home/agent/.codex/sessions rw,relatime - nfs4 agenticfs rw
26 24 0:45 /workspace /home/agent/workspace rw,relatime - nfs4 agenticfs rw
`)

	if err := requireMounts(mountInfo, "/home/agent/.codex/sessions", "/home/agent/workspace"); err != nil {
		t.Fatalf("requireMounts() error = %v", err)
	}
}

func TestRequiredMountsReportMissingMount(t *testing.T) {
	mountInfo := strings.NewReader(`24 19 0:22 / / rw,relatime - overlay overlay rw
25 24 0:45 /session /home/agent/.codex/sessions rw,relatime - nfs4 agenticfs rw
`)

	if err := requireMounts(mountInfo, "/home/agent/.codex/sessions", "/home/agent/workspace"); err == nil {
		t.Fatal("requireMounts() error = nil, want missing workspace mount")
	}
}
