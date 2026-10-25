// 这些测试确认本地 ACP 地址格式错误时会尽早报错，而不是等到提问时才失败。
package sandbox

import (
	"testing"

	"github.com/example/tinyagent/internal/acpproxy"
)

func TestLocalProgressPhases(t *testing.T) {
	got := localProgressPhases()
	if len(got) != 2 || got[0] != (acpproxy.SandboxProgress{Phase: acpproxy.StatusPhaseAgentConnecting, Label: "连接本地 Agent", Source: acpproxy.SandboxSourceLocal}) || got[1] != (acpproxy.SandboxProgress{Phase: acpproxy.StatusPhaseAgentReady, Label: "本地 Agent 已连接", Source: acpproxy.SandboxSourceLocal}) {
		t.Fatalf("local progress = %#v", got)
	}
}

func TestNewLocalManagerRejectsEmptyEndpoint(t *testing.T) {
	if _, err := NewLocalManager(""); err == nil {
		t.Fatal("NewLocalManager() error = nil, want error")
	}
}
