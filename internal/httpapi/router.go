// httpapi 包提供浏览器调用的 JSON 接口和一条用于流式回答的 WebSocket。
//
// Router 只负责把稳定的浏览器 URL 映射到对应的业务 handler；session 和 prompt
// 的请求处理分别放在各自的类型中，避免路由装配和业务逻辑互相混在一起。
package httpapi

import "net/http"

// NewRouter 组装浏览器 API 的路由。
func NewRouter(sessions *SessionHandler, prompt *PromptHandler) http.Handler {
	mux := http.NewServeMux()
	// 健康检查只回答“HTTP 进程还活着”。不在这里查询数据库、模型或沙箱，
	// 因为 Kubernetes 探针会频繁访问它，不能让探针制造业务流量。
	mux.HandleFunc("GET /healthz", health)
	mux.HandleFunc("GET /api/sessions", sessions.List)
	mux.HandleFunc("POST /api/sessions", sessions.Create)
	mux.HandleFunc("GET /api/sessions/{id}/messages", sessions.ListMessages)
	mux.HandleFunc("GET /api/sessions/{id}/prompt", prompt.ServeHTTP)
	// 网页和 API 经同一个本地入口提供；不授予任意网站跨源调用真实 Agent 的权限。
	return mux
}

func health(writer http.ResponseWriter, _ *http.Request) {
	writer.WriteHeader(http.StatusOK)
}
