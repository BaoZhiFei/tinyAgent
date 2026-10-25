package acpproxy

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestStatusTimingsMeasurePreviousPhaseBeforeAdvancing(t *testing.T) {
	started := time.Unix(0, 0)
	phaseStarted := started.Add(200 * time.Millisecond)
	elapsed, total := statusTimings(started, phaseStarted, started.Add(750*time.Millisecond))
	if elapsed != 550 || total != 750 {
		t.Fatalf("statusTimings() = %d, %d, want 550, 750", elapsed, total)
	}
}

func TestTurnStatusJSONDoesNotExposeInfrastructureDetails(t *testing.T) {
	payload := publicStatusPayload(TurnStatus{
		Phase:          StatusPhaseSandboxWaiting,
		Label:          "等待沙箱就绪",
		SandboxSource:  SandboxSourceWarmPool,
		ElapsedMs:      1234,
		TotalElapsedMs: 1234,
		Infrastructure: "claim=tinyagent-secret ip=10.0.0.1 raw error",
	})
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, forbidden := range []string{"tinyagent-secret", "10.0.0.1", "raw error", "infrastructure"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("status JSON contains forbidden detail %q: %s", forbidden, text)
		}
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["phase"] != string(StatusPhaseSandboxWaiting) || decoded["sandboxSource"] != string(SandboxSourceWarmPool) {
		t.Fatalf("public status = %#v", decoded)
	}
}

func TestACPStatusPhasesAreStable(t *testing.T) {
	if StatusPhaseACPInitializing != "acp_initializing" {
		t.Fatalf("ACP initialize phase = %q", StatusPhaseACPInitializing)
	}
	if StatusPhaseACPSessionInitializing != "acp_session_initializing" {
		t.Fatalf("ACP session phase = %q", StatusPhaseACPSessionInitializing)
	}
	if StatusPhaseACPReady != "acp_ready" {
		t.Fatalf("ACP ready phase = %q", StatusPhaseACPReady)
	}
}
