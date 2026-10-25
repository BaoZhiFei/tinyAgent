// 这些测试确认只有真正运行、就绪并拥有 IP 的 Sandbox 才会交给 ACP 使用。
package sandbox

import (
	"testing"
	"time"

	"github.com/example/tinyagent/internal/acpproxy"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestManagerUsesResponsiveSandboxPollInterval(t *testing.T) {
	manager := NewManager(nil, "tinyagent", "tinyagent-pool", "pv", "5m", time.Minute)
	if manager.pollInterval != 250*time.Millisecond {
		t.Fatalf("poll interval = %s, want 250ms", manager.pollInterval)
	}
}

func TestKubernetesProgressPhases(t *testing.T) {
	got := kubernetesProgressPhases()
	want := []acpproxy.SandboxProgress{
		{Phase: acpproxy.StatusPhaseSandboxClaiming, Label: "领取沙箱", Source: acpproxy.SandboxSourceWarmPool},
		{Phase: acpproxy.StatusPhaseSandboxWaiting, Label: "等待沙箱就绪", Source: acpproxy.SandboxSourceProvisioning},
		{Phase: acpproxy.StatusPhaseAgentConnecting, Label: "连接 Agent", Source: acpproxy.SandboxSourceProvisioning},
		{Phase: acpproxy.StatusPhaseAgentReady, Label: "Agent 已连接", Source: acpproxy.SandboxSourceProvisioning},
	}
	if len(got) != len(want) {
		t.Fatalf("progress count = %d, want %d", len(got), len(want))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("progress[%d] = %#v, want %#v", index, got[index], want[index])
		}
	}
}

func TestReadyEndpointRequiresRunningReadySandboxWithIP(t *testing.T) {
	cases := []struct {
		name      string
		object    map[string]any
		wantIP    string
		wantReady bool
	}{
		{"not running", map[string]any{"status": map[string]any{"phase": "Pending"}}, "", false},
		{"not ready", map[string]any{"status": map[string]any{"phase": "Running", "conditions": []any{map[string]any{"type": "Ready", "status": "False"}}}}, "", false},
		{"ready", map[string]any{"status": map[string]any{"phase": "Running", "conditions": []any{map[string]any{"type": "Ready", "status": "True"}}, "sandboxIp": "10.0.0.1"}}, "10.0.0.1", true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			gotIP, gotReady := readyEndpoint(&unstructured.Unstructured{Object: test.object})
			if gotIP != test.wantIP || gotReady != test.wantReady {
				t.Fatalf("readyEndpoint() = %q, %v", gotIP, gotReady)
			}
		})
	}
}

func TestSandboxSourceUsesAvailablePoolCapacity(t *testing.T) {
	if got := sandboxSourceFromAvailable(2, true); got != acpproxy.SandboxSourceWarmPool {
		t.Fatalf("sandboxSource() = %q, want warm_pool", got)
	}
	if got := sandboxSourceFromAvailable(0, true); got != acpproxy.SandboxSourceProvisioning {
		t.Fatalf("sandboxSource() = %q, want provisioning", got)
	}
}

func TestReadySandboxCanBeUsedWhenClaimStatusLags(t *testing.T) {
	items := []unstructured.Unstructured{{Object: map[string]any{
		"status": map[string]any{
			"phase":     "Running",
			"sandboxIp": "10.0.0.1",
			"conditions": []any{
				map[string]any{"type": "Ready", "status": "True"},
			},
		},
	}}}

	got, ready := readySandboxEndpoint(items)
	if !ready || got != "10.0.0.1" {
		t.Fatalf("readySandboxEndpoint() = %q, %v, want 10.0.0.1, true", got, ready)
	}
}
