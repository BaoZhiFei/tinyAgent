// 这些测试保护浏览器依赖的 HTTP 状态码、JSON 结构和 WebSocket 路由行为。
package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/example/tinyagent/internal/session"
)

type promptServiceFunc func(http.ResponseWriter, *http.Request, string)

func (handler promptServiceFunc) ServePrompt(writer http.ResponseWriter, request *http.Request, sessionID string) {
	handler(writer, request, sessionID)
}

func newTestRouter() http.Handler {
	return NewRouter(NewSessionHandler(session.NewMemoryStore()), NewPromptHandler(nil))
}

func TestRouterRoutesPromptThroughPromptHandler(t *testing.T) {
	var gotSessionID string
	handler := NewRouter(NewSessionHandler(session.NewMemoryStore()), NewPromptHandler(promptServiceFunc(func(writer http.ResponseWriter, _ *http.Request, sessionID string) {
		gotSessionID = sessionID
		writer.WriteHeader(http.StatusAccepted)
	})))

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions/session-7/prompt", nil))

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusAccepted)
	}
	if gotSessionID != "session-7" {
		t.Fatalf("session ID = %q, want session-7", gotSessionID)
	}
}

func TestHealthEndpointReturnsOK(t *testing.T) {
	response := httptest.NewRecorder()
	newTestRouter().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
}

func TestACPSessionPromptWebSocketRequiresConfiguredProxy(t *testing.T) {
	response := httptest.NewRecorder()
	newTestRouter().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions/session-1/prompt", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	var body map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "ACP 代理尚未配置" {
		t.Fatalf("error = %q, want ACP proxy configuration error", body["error"])
	}
}

func TestLegacySessionResourceEndpointsAreRemoved(t *testing.T) {
	for _, path := range []string{
		"/api/conversations",
		"/api/conversations/session-1/messages",
		"/api/conversations/session-1/prompt",
	} {
		response := httptest.NewRecorder()
		newTestRouter().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Errorf("%s status = %d, want %d", path, response.Code, http.StatusNotFound)
		}
	}
}

func TestCreateSession(t *testing.T) {
	response := httptest.NewRecorder()
	newTestRouter().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/sessions", bytes.NewBufferString(`{"title":"演示"}`)))
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", response.Code, response.Body.String())
	}
}

func TestRouterDoesNotGrantCrossOriginBrowserAccess(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	request.Header.Set("Origin", "https://untrusted.example")
	response := httptest.NewRecorder()

	newTestRouter().ServeHTTP(response, request)

	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want no cross-origin grant", got)
	}
}

func TestSessionMessagesReturnsJSON(t *testing.T) {
	store := session.NewMemoryStore()
	session, err := store.CreateSession(t.Context(), "演示")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	NewRouter(NewSessionHandler(store), NewPromptHandler(nil)).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions/"+session.ID+"/messages", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
}

// 空列表必须编码为 [] 而不是 null；浏览器会直接遍历这个结果，null 会让新对话页面白屏。
func TestEmptySessionEndpointsReturnJSONArray(t *testing.T) {
	store := session.NewMemoryStore()
	router := NewRouter(NewSessionHandler(store), NewPromptHandler(nil))

	sessionList := httptest.NewRecorder()
	router.ServeHTTP(sessionList, httptest.NewRequest(http.MethodGet, "/api/sessions", nil))
	if got := strings.TrimSpace(sessionList.Body.String()); got != "[]" {
		t.Fatalf("empty session list = %q, want []", got)
	}

	created, err := store.CreateSession(t.Context(), "新对话")
	if err != nil {
		t.Fatal(err)
	}
	messageList := httptest.NewRecorder()
	router.ServeHTTP(messageList, httptest.NewRequest(http.MethodGet, "/api/sessions/"+created.ID+"/messages", nil))
	if got := strings.TrimSpace(messageList.Body.String()); got != "[]" {
		t.Fatalf("empty message list = %q, want []", got)
	}
}
