package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/example/tinyagent/internal/session"
)

// SessionHandler 处理 session 列表、创建和历史消息接口。
type SessionHandler struct {
	store session.Store
}

// NewSessionHandler 创建只依赖 session 存储的 HTTP handler。
func NewSessionHandler(store session.Store) *SessionHandler {
	return &SessionHandler{store: store}
}

// List 返回左侧 session 列表。
func (h *SessionHandler) List(writer http.ResponseWriter, request *http.Request) {
	// 首页只读 session 的标题和时间等基本信息；消息由另一个接口按需读取，
	// 避免历史很长时一次性塞满首页响应。
	sessions, err := h.store.ListSessions(request.Context())
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "无法读取 session 列表")
		return
	}
	// JSON 中的 null 不是空数组。前端需要无条件遍历这里的结果，因此把存储层
	// 可能给出的 nil 统一为 []，避免一个空数据库就让整个页面白屏。
	if sessions == nil {
		sessions = []session.Session{}
	}
	writeJSON(writer, http.StatusOK, sessions)
}

// Create 创建一个空 session；真正提问时才启动 Agent 或领取沙箱。
func (h *SessionHandler) Create(writer http.ResponseWriter, request *http.Request) {
	// 同时限制请求体大小，避免无意义的大请求占用内存。
	var input struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 64<<10)).Decode(&input); err != nil {
		writeError(writer, http.StatusBadRequest, "请求格式不正确")
		return
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" {
		input.Title = "新 session"
	}
	created, err := h.store.CreateSession(request.Context(), input.Title)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "无法创建 session")
		return
	}
	writeJSON(writer, http.StatusCreated, created)
}

// ListMessages 返回指定 session 的网页历史消息。
func (h *SessionHandler) ListMessages(writer http.ResponseWriter, request *http.Request) {
	messages, err := h.store.ListMessages(request.Context(), request.PathValue("id"))
	if err != nil {
		writeStoreError(writer, err)
		return
	}
	// 新建 session 还没有消息是正常状态，接口仍须返回 []，而不是 JSON null。
	if messages == nil {
		messages = []session.Message{}
	}
	writeJSON(writer, http.StatusOK, messages)
}
