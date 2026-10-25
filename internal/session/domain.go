package session

import "time"

// Role 表示消息是用户说的，还是 Agent 回复的。
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// Session 是网页对话的基本信息，也是恢复 ACP 对话的入口。
//
// ACPSessionID 只保存 ACP 返回的逻辑编号，不保存完整对话内容；Codex 真正恢复所需的
// rollout 文件仍在 AgenticFS 中。数据库记录丢了找不到编号，文件丢了也无法恢复，二者缺一不可。
type Session struct {
	ID, Title, ACPSessionID string
	CreatedAt, UpdatedAt    time.Time
}

// Message 是网页历史中的一条消息，Sequence 决定它在对话里的顺序。
//
// 它保存浏览器历史需要显示的最终文字，不保存 ACP 原始 JSON-RPC 日志、思考过程或工具细节。
type Message struct {
	SessionID string
	Sequence  int
	Role      Role
	Text      string
	CreatedAt time.Time
}
