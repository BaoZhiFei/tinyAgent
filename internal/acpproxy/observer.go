// 本文件负责从 ACP 消息中整理网页需要的历史记录。
// 它拿到的是转发前复制的一份消息，只负责“看”和保存，不参与消息转发，
// 也不会修改浏览器或 Agent 实际收到的内容。
package acpproxy

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"github.com/example/tinyagent/internal/session"
)

// Observer 记录一条 WebSocket 连接中的用户问题、Agent 回复和 ACP session ID。
// 一条连接只创建一个 Observer，这样本轮临时数据不会和别的连接混在一起。
//
// sessionRequests 和 promptRequests 用 JSON-RPC request ID 做关联：ACP 的 session
// 响应和 prompt 响应可能夹在通知之间，不能按“下一条消息”猜测它们的含义。
type Observer struct {
	store           session.Store
	localSessionID  string
	mu              sync.Mutex
	sessionRequests map[string]bool
	promptRequests  map[string]bool
	acpSessionID    string
	userText        string
	agentText       strings.Builder
	promptStarted   bool
	currentPromptID string
}

func NewObserver(store session.Store, sessionID string) *Observer {
	// 每个 WebSocket 连接都重新开始记录；数据库里的旧消息不放进这里，
	// 这样 session/load 重播旧历史时，不会把旧消息再次保存一遍。
	return &Observer{
		store:           store,
		localSessionID:  sessionID,
		sessionRequests: map[string]bool{},
		promptRequests:  map[string]bool{},
	}
}

func (o *Observer) ObserveClient(payload []byte) {
	// 这里解析失败只影响“保存历史”，不能影响 ACP 本身继续通信。
	// 真正负责检查协议的是浏览器和 Agent，这个记录器不抢它们的工作。
	var message struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if json.Unmarshal(payload, &message) != nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if (message.Method == "session/new" || message.Method == "session/load") && len(message.ID) > 0 {
		// 先记住请求编号。Agent 的响应可能被其他通知插在中间，
		// 只能靠编号确认这个 sessionId 属于 session/new 或 session/load。
		o.sessionRequests[string(message.ID)] = true
	}
	if message.Method == "session/prompt" && len(message.ID) > 0 {
		// 从第一条真正的问题开始，后面的 Agent 回复才属于本轮新对话。
		// 在此之前收到的内容可能只是 session/load 重播的旧历史。
		o.promptRequests[string(message.ID)] = true
		o.currentPromptID = string(message.ID)
		o.userText = ""
		o.agentText.Reset()
		o.promptStarted = true
	}
	if message.Method != "session/prompt" {
		return
	}
	var params struct {
		Prompt []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"prompt"`
	}
	if json.Unmarshal(message.Params, &params) != nil {
		return
	}
	for _, block := range params.Prompt {
		if block.Type == "text" {
			o.userText += block.Text
		}
	}
}

func (o *Observer) ObserveAgent(ctx context.Context, payload []byte) error {
	// 解析不了的消息直接跳过，原消息仍然照常发给浏览器。
	// 只有写数据库失败才返回错误，因为这会导致网页历史不完整。
	var message struct {
		ID     json.RawMessage `json:"id"`
		Result json.RawMessage `json:"result"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if json.Unmarshal(payload, &message) != nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(message.ID) > 0 && o.sessionRequests[string(message.ID)] {
		var result struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(message.Result, &result) == nil {
			o.acpSessionID = result.SessionID
		}
	}
	if o.promptStarted && message.Method == "session/update" {
		// 只拼接本轮给用户看的文字片段。思考过程、工具调用和旧历史虽然会发给浏览器，
		// 但它们不是本轮最终回复，不能写进网页的 assistant 消息。
		var params struct {
			Update struct {
				SessionUpdate string                      `json:"sessionUpdate"`
				Content       struct{ Type, Text string } `json:"content"`
			} `json:"update"`
		}
		if json.Unmarshal(message.Params, &params) == nil && params.Update.SessionUpdate == "agent_message_chunk" && params.Update.Content.Type == "text" {
			o.agentText.WriteString(params.Update.Content.Text)
		}
	}
	if len(message.ID) > 0 && o.promptRequests[string(message.ID)] && string(message.ID) == o.currentPromptID {
		// 收到本轮 prompt 的最终响应后马上保存。这样即使随后 WebSocket 意外断开，
		// 用户问题和 Agent 回复也已经留在数据库里。
		if err := o.finalizeTurnLocked(ctx); err != nil {
			return err
		}
		delete(o.promptRequests, string(message.ID))
		o.currentPromptID = ""
		o.userText = ""
		o.agentText.Reset()
		o.promptStarted = false
	}
	return nil
}

func (o *Observer) Finalize(ctx context.Context) error {
	// 连接结束时只补保存尚未收到最终响应的当前轮，已经完成的轮次不会重复写入。
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.promptStarted {
		if err := o.finalizeTurnLocked(ctx); err != nil {
			return err
		}
		o.promptStarted = false
		o.currentPromptID = ""
		o.userText = ""
		o.agentText.Reset()
	}
	return o.saveSessionLocked(ctx)
}

func (o *Observer) saveSessionLocked(ctx context.Context) error {
	if o.acpSessionID != "" {
		// 先保存 ACP session ID。下一次提问会用它执行 session/load，
		// Agent 才能从 AgenticFS 找回上一次留下的会话文件。
		if err := o.store.SaveACPSession(ctx, o.localSessionID, o.acpSessionID); err != nil {
			return err
		}
	}
	return nil
}

func (o *Observer) finalizeTurnLocked(ctx context.Context) error {
	if err := o.saveSessionLocked(ctx); err != nil {
		return err
	}
	// 数据库里的消息才是网页历史的准绳。以已有条数继续编号，
	// 不把 ACP 的每条原始通知直接塞进消息表。
	messages, err := o.store.ListMessages(ctx, o.localSessionID)
	if err != nil {
		return err
	}
	if len(messages) == 0 && o.userText != "" {
		if err := o.store.SetTitle(ctx, o.localSessionID, sessionTitle(o.userText)); err != nil {
			return err
		}
	}
	sequence := len(messages) + 1
	if o.userText != "" {
		if err := o.store.AppendMessage(ctx, session.Message{SessionID: o.localSessionID, Sequence: sequence, Role: session.RoleUser, Text: o.userText}); err != nil {
			return err
		}
		sequence++
	}
	if text := o.agentText.String(); text != "" {
		if err := o.store.AppendMessage(ctx, session.Message{SessionID: o.localSessionID, Sequence: sequence, Role: session.RoleAssistant, Text: text}); err != nil {
			return err
		}
	}
	return nil
}

func sessionTitle(text string) string {
	title := strings.TrimSpace(text)
	runes := []rune(title)
	if len(runes) > 40 {
		title = string(runes[:40])
	}
	return title
}
