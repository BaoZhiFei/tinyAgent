// tinyagent 启动 tinyAgent 的 HTTP 服务。
//
// 从这里读起：先打开 PostgreSQL（页面历史和 ACP 会话编号），再以 Pod 自己的
// ServiceAccount 身份连接 ACK，最后把“网页 → 对话服务 → 沙箱桥 → Codex ACP”接起来。
// 服务自身不保存会话状态，因此未来增加副本时可以由任意一台继续处理同一段对话。
package main

import (
	"context"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/tinyagent/internal/acpproxy"
	"github.com/example/tinyagent/internal/config"
	"github.com/example/tinyagent/internal/httpapi"
	"github.com/example/tinyagent/internal/sandbox"
	"github.com/example/tinyagent/internal/session"
)

func main() {
	// 配置读取放在所有外部连接之前。DATABASE_URL、Kubernetes 资源名或时长配置
	// 缺失时应立即失败，而不是启动一个只能在第一次聊天时才暴露问题的 HTTP 服务。
	configuration, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	// 信号 context 同时服务于数据库连接、沙箱选择和 HTTP server：收到 SIGINT/SIGTERM
	// 后，后续新请求会看到取消状态，HTTP server 也会进入有时限的优雅关闭流程。
	runContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// PostgreSQL 保存网页可见的 session、消息和 ACP session ID；它不保存 Codex
	// 在 AgenticFS 中维护的会话文件。服务退出时先关闭应用，再关闭连接池。
	store, err := session.OpenPostgres(runContext, configuration.DatabaseURL)
	if err != nil {
		log.Fatalf("open session store: %v", err)
	}
	defer store.Close()
	// Sandbox 接口把两种运行模式统一起来：本地 Compose 直接连接 bridge，云端则
	// 通过 Kubernetes SandboxClaim 领取临时沙箱。HTTP 和 ACP 层不需要知道当前是哪一种。
	var manager acpproxy.Sandbox
	if configuration.LocalACPEndpoint != "" {
		// 本地模式不创建 SandboxClaim，LocalManager 只连接 Compose 中的 agent 服务。
		manager, err = sandbox.NewLocalManager(configuration.LocalACPEndpoint)
	} else {
		// 云端模式使用 Pod 的 ServiceAccount（或显式本地 kubeconfig）访问 Kubernetes。
		// NewManager 保存命名空间、预热池、AgenticFS PV 和生命周期限制，真正领取发生在 prompt 时。
		kubernetesClient, clientErr := sandbox.NewDynamicClient(configuration.KubeconfigPath)
		if clientErr != nil {
			log.Fatalf("connect ACK sandbox API: %v", clientErr)
		}
		manager = sandbox.NewManager(kubernetesClient, configuration.SandboxNS, configuration.PoolName, configuration.PersistentVolumeName, configuration.ClaimTimeout.String(), configuration.MaxLifetime)
	}
	if err != nil {
		log.Fatalf("connect local ACP endpoint: %v", err)
	}
	// 先分别构造 session 和 prompt handler，再交给 Router 装配 URL；这样启动入口
	// 清楚表达“存储能力 + ACP 能力 + HTTP 路由”的组合关系。
	sessionHandler := httpapi.NewSessionHandler(store)
	promptHandler := httpapi.NewPromptHandler(acpproxy.NewWithOptions(store, manager, acpproxy.ProxyOptions{
		IdleTimeout: configuration.IdleTimeout,
	}))
	handler := httpapi.NewRouter(sessionHandler, promptHandler)
	// ReadHeaderTimeout 只限制读取 HTTP 请求头的时间，不限制 ACP prompt 的执行时间；
	// 后者由 WebSocket、沙箱 Claim 和 Agent 生命周期分别管理。
	server := &http.Server{Addr: configuration.ListenAddress, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("tinyAgent listening on %s", configuration.ListenAddress)
	go func() {
		<-runContext.Done()
		// 给正在进行的请求最多 15 秒完成协议关闭和资源释放；超时后 server.Shutdown
		// 会返回，进程随后退出。ACP 代理自身还会通过 defer 释放租约和沙箱。
		shutdownContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownContext)
	}()
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
