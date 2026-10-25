package acpproxy

import (
	"context"
	"io"
)

// Sandbox 为一段会话提供 ACP 双向字节流和释放函数。
// release 必须在连接结束时调用；云端实现会删除 Claim 和已领取的 Sandbox，
// 本地实现则只关闭本地流。
type Sandbox interface {
	Acquire(context.Context, string) (io.ReadWriteCloser, func(context.Context) error, error)
}

// SandboxProgress 是云端和本地实现都能使用的进度信息。
// 它可以安全地显示给用户，故意不包含内网 IP、Claim 名称或底层错误原文。
type SandboxProgress struct {
	Phase  StatusPhase
	Label  string
	Source SandboxSource
}

// ObservableSandbox 是可选能力：实现了它就能把“领取中、等待中、已连接”等阶段
// 发给网页；没有实现时，代理会退回使用普通的 Acquire，不影响旧的测试替身。
type ObservableSandbox interface {
	Sandbox
	AcquireWithProgress(context.Context, string, func(SandboxProgress)) (io.ReadWriteCloser, func(context.Context) error, error)
}
