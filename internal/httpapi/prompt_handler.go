package httpapi

import "net/http"

// PromptService 是 HTTP 层需要的最小 ACP 能力。
// 它不暴露沙箱、数据库或 ACP 代理的内部结构。
type PromptService interface {
	ServePrompt(http.ResponseWriter, *http.Request, string)
}

// PromptHandler 处理一个 session 的 ACP WebSocket 请求。
type PromptHandler struct {
	service PromptService
}

// NewPromptHandler 创建 prompt HTTP handler。
func NewPromptHandler(service PromptService) *PromptHandler {
	return &PromptHandler{service: service}
}

// ServeHTTP 将 prompt 请求交给 ACP 服务。
func (h *PromptHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	// 这个地址升级成 WebSocket 后，initialize、session、prompt 等 ACP 消息
	// 由浏览器和 Agent 直接协商，HTTP 层不拆开或改写这些消息。
	if h.service == nil {
		writeError(writer, http.StatusServiceUnavailable, "ACP 代理尚未配置")
		return
	}
	h.service.ServePrompt(writer, request, request.PathValue("id"))
}
