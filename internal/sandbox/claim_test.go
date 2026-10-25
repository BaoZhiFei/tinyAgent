// 这些测试确认领取沙箱时的资源名称、持久化目录和挂载配置不会被改错。
package sandbox

import (
	"testing"
	"time"
)

func TestBuildClaimMountsWorkspaceAndCodexSessions(t *testing.T) {
	claim, err := BuildClaim("tinyagent", "tinyagent-pool", "session-1", "pv-1", "10m", 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	mounts := claim.Object["spec"].(map[string]any)["dynamicVolumesMount"].([]any)
	specification := claim.Object["spec"].(map[string]any)
	if specification["waitReadyTimeout"] != "10m" {
		t.Fatalf("wait ready timeout = %v, want claim timeout", specification["waitReadyTimeout"])
	}
	if len(mounts) != 2 {
		t.Fatalf("mount count = %d, want 2", len(mounts))
	}
	if mounts[1].(map[string]any)["mountPath"] != "/home/agent/.codex/sessions" {
		t.Fatalf("memory mount = %#v", mounts[1])
	}
	annotations := specification["annotations"].(map[string]any)
	if annotations["security.agents.kruise.io/agent-name"] != "tinyagent-storage-agent" {
		t.Fatalf("agent identity annotation = %#v", annotations)
	}
	for _, mount := range mounts {
		attributes := mount.(map[string]any)["attributes"].(map[string]any)
		if attributes["credentialProviderName"] != "agenticfs-read-write" {
			t.Fatalf("mount credential provider = %#v", attributes)
		}
	}
}
