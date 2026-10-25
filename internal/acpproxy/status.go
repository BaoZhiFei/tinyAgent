package acpproxy

// StatusPhase 是浏览器可以显示的一小组稳定状态。
// 这些值属于前后端约定，改名会让网页无法正确显示进度。
type StatusPhase string

const (
	StatusPhaseConnecting             StatusPhase = "connecting"
	StatusPhaseSandboxClaiming        StatusPhase = "sandbox_claiming"
	StatusPhaseSandboxWaiting         StatusPhase = "sandbox_waiting"
	StatusPhaseAgentConnecting        StatusPhase = "agent_connecting"
	StatusPhaseAgentReady             StatusPhase = "agent_ready"
	StatusPhaseACPInitializing        StatusPhase = "acp_initializing"
	StatusPhaseACPSessionInitializing StatusPhase = "acp_session_initializing"
	StatusPhaseACPReady               StatusPhase = "acp_ready"
	StatusPhaseThinking               StatusPhase = "thinking"
	StatusPhaseToolCalling            StatusPhase = "tool_calling"
	StatusPhaseResponding             StatusPhase = "responding"
	StatusPhaseCompleted              StatusPhase = "completed"
	StatusPhaseFailed                 StatusPhase = "failed"
)

// SandboxSource 只告诉用户“沙箱来自预热池、临时创建，还是本地环境”。
// 它不会把内网 IP、Claim 名称等基础设施细节暴露给浏览器。
type SandboxSource string

const (
	SandboxSourceWarmPool     SandboxSource = "warm_pool"
	SandboxSourceProvisioning SandboxSource = "provisioning"
	SandboxSourceLocal        SandboxSource = "local"
)

// TurnStatus 是服务内部使用的完整进度信息。
// Infrastructure 只留给日志和排查使用，不能放进发给浏览器的 JSON。
type TurnStatus struct {
	Phase          StatusPhase
	Label          string
	SandboxSource  SandboxSource
	ElapsedMs      int64
	TotalElapsedMs int64
	Infrastructure string
}

type publicStatus struct {
	Phase          StatusPhase   `json:"phase"`
	Label          string        `json:"label"`
	SandboxSource  SandboxSource `json:"sandboxSource,omitempty"`
	ElapsedMs      int64         `json:"elapsedMs"`
	TotalElapsedMs int64         `json:"totalElapsedMs"`
}

func publicStatusPayload(status TurnStatus) publicStatus {
	return publicStatus{
		Phase:          status.Phase,
		Label:          status.Label,
		SandboxSource:  status.SandboxSource,
		ElapsedMs:      status.ElapsedMs,
		TotalElapsedMs: status.TotalElapsedMs,
	}
}
