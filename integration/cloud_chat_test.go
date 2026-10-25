//go:build integration

// Package integration 放置会真实消耗云资源的验收测试。
//
// 从这里读起：单元测试负责守住 Go 代码的局部行为；本包只在显式带上 integration
// 标签和 TINYAGENT_BASE_URL 时运行，用来确认公网入口、ACK 沙箱、ACP、模型服务和
// 对话落库这条跨服务链路没有断。它绝不进入默认 CI，避免每次提交都创建沙箱和调用模型。
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestCloudChatPromptCompletes 守护真实的“一句用户消息最终收到 done”承诺。
// 若有人断开了 Ingress、SandboxClaim、沙箱桥、ACP 或模型任一环节，测试不会以
// HTTP 创建对话成功而假绿，而会在 WebSocket prompt 上超时或收到 error 事件。
func TestCloudChatPromptCompletes(t *testing.T) {
	baseURL := strings.TrimRight(os.Getenv("TINYAGENT_BASE_URL"), "/")
	if baseURL == "" {
		t.Skip("未设置 TINYAGENT_BASE_URL；真实云端验收需要显式授权")
	}

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Minute)
	defer cancel()

	sessionID := createSession(t, ctx, baseURL)
	runCloudPrompt(t, ctx, baseURL, sessionID, "请只回复 tinyAgent 云端验收成功")
}

// TestCloudChatResumesSession 守护“一个 prompt turn 结束、沙箱归还、下一次 prompt 仍能恢复”的承诺。
// 两个 prompt 之间服务会释放第一台 Sandbox；第二个 prompt 必须重新领取沙箱，并从 AgenticFS 读回 Codex
// rollout。若挂载权限、会话文件路径或 ACP session/resume 任一环节失效，第二个 prompt 会返回 error
// 或在超时前没有 done，而不是被仅检查首轮对话的测试漏掉。
func TestCloudChatResumesSession(t *testing.T) {
	baseURL := strings.TrimRight(os.Getenv("TINYAGENT_BASE_URL"), "/")
	if baseURL == "" {
		t.Skip("未设置 TINYAGENT_BASE_URL；真实云端验收需要显式授权")
	}

	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Minute)
	defer cancel()

	sessionID := createSession(t, ctx, baseURL)
	runCloudPrompt(t, ctx, baseURL, sessionID, "请只回复第一条 prompt 已保存")
	runCloudPrompt(t, ctx, baseURL, sessionID, "请只回复第二条 prompt 恢复成功")
}

func runCloudPrompt(t *testing.T, ctx context.Context, baseURL, sessionID, text string) {
	t.Helper()
	promptURL := websocketURL(t, baseURL+"/api/sessions/"+sessionID+"/prompt")
	connection, response, err := websocket.Dial(ctx, promptURL, nil)
	if err != nil {
		if response != nil {
			t.Fatalf("连接对话 WebSocket: %v，HTTP 状态=%s", err, response.Status)
		}
		t.Fatalf("连接对话 WebSocket: %v", err)
	}
	defer connection.Close(websocket.StatusNormalClosure, "验收完成")

	prompt, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		t.Fatalf("编码测试消息: %v", err)
	}
	if err := connection.Write(ctx, websocket.MessageText, prompt); err != nil {
		t.Fatalf("发送测试消息: %v", err)
	}

	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			t.Fatalf("读取 Agent prompt 事件: %v", err)
		}
		var event struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(payload, &event); err != nil {
			t.Fatalf("解析 Agent prompt 事件 %q: %v", payload, err)
		}
		switch event.Type {
		case "done":
			return
		case "error":
			t.Fatalf("Agent prompt 失败: %s", event.Text)
		}
	}
}

func createSession(t *testing.T, ctx context.Context, baseURL string) string {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/sessions", bytes.NewBufferString(`{"title":"云端自动验收"}`))
	if err != nil {
		t.Fatalf("创建对话请求: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("创建对话: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		t.Fatalf("创建对话状态=%s，响应=%s", response.Status, body)
	}
	var session struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&session); err != nil {
		t.Fatalf("解析新对话: %v", err)
	}
	if session.ID == "" {
		t.Fatal("创建对话成功但没有返回 ID")
	}
	return session.ID
}

func websocketURL(t *testing.T, rawURL string) string {
	t.Helper()
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("解析入口地址: %v", err)
	}
	switch parsedURL.Scheme {
	case "http":
		parsedURL.Scheme = "ws"
	case "https":
		parsedURL.Scheme = "wss"
	default:
		t.Fatalf("入口地址协议必须是 http 或 https，实际是 %q", parsedURL.Scheme)
	}
	if parsedURL.Host == "" {
		t.Fatal("入口地址缺少域名")
	}
	return parsedURL.String()
}

func Example() {
	// 这条命令刻意只在人工验收或发布后执行，会创建一段演示对话并调用一次模型。
	fmt.Println("TINYAGENT_BASE_URL=https://tinyagent.baozhifei.com go test -tags integration ./integration -run TestCloudChatPromptCompletes -v")
	// Output:
	// TINYAGENT_BASE_URL=https://tinyagent.baozhifei.com go test -tags integration ./integration -run TestCloudChatPromptCompletes -v
}
