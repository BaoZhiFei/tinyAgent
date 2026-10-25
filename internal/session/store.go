package session

import (
	"context"
	"errors"
	"time"
)

// ErrSessionBusy 表示另一条连接正在使用这个 session，当前请求不能同时进行。
var ErrSessionBusy = errors.New("session is busy")

// ErrSessionNotFound 表示请求中的 session 编号不存在。
var ErrSessionNotFound = errors.New("session not found")

// Lease 表示某个请求暂时独占一个 session 的权利。
//
// 同一 session 同时只能有一个活动 prompt，避免两个浏览器连接同时领取沙箱，
// 又同时修改同一份 ACP 会话。拿到 Lease 的调用方无论成功失败都必须调用 Release。
type Lease interface{ Release(context.Context) error }

// Store 定义服务保存对话所需要的能力。
//
// HTTP 层和 ACP 层只依赖这个接口，所以单元测试可以使用 MemoryStore，线上使用
// PostgresStore。两种实现必须对空列表、错误和租约给出相同的结果，避免测试通过而线上行为不同。
type Store interface {
	CreateSession(context.Context, string) (Session, error)
	GetSession(context.Context, string) (Session, error)
	ListSessions(context.Context) ([]Session, error)
	SetTitle(context.Context, string, string) error
	ListMessages(context.Context, string) ([]Message, error)
	AppendMessage(context.Context, Message) error
	SaveACPSession(context.Context, string, string) error
	AcquireLease(context.Context, string, string, time.Duration) (Lease, error)
}
