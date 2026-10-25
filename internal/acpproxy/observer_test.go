// 这些测试确认 Observer 只保存网页历史需要的内容，并且会在 prompt 完成时及时落库。
package acpproxy

import (
	"context"
	"testing"

	"github.com/example/tinyagent/internal/session"
)

func TestObserverPersistsACPDisplayMessagesAndSession(t *testing.T) {
	// 用户问题、Agent 回复和 ACP session ID 都应分别保存，思考内容不能混进网页历史。
	store := session.NewMemoryStore()
	record, err := store.CreateSession(context.Background(), "test")
	if err != nil {
		t.Fatal(err)
	}
	observer := NewObserver(store, record.ID)
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"result":{"sessionId":"session-1"}}`))
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"hello"}]}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"answer"}}}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"private"}}}}`))
	if err := observer.Finalize(context.Background()); err != nil {
		t.Fatal(err)
	}
	updated, _ := store.GetSession(context.Background(), record.ID)
	if updated.Title != "hello" {
		t.Fatalf("title = %q, want first user prompt", updated.Title)
	}
	if updated.ACPSessionID != "session-1" {
		t.Fatalf("session = %q", updated.ACPSessionID)
	}
	messages, _ := store.ListMessages(context.Background(), record.ID)
	if len(messages) != 2 || messages[0].Text != "hello" || messages[1].Text != "answer" {
		t.Fatalf("messages = %#v", messages)
	}
}

func TestObserverPersistsTurnBeforePromptResponseReachesBrowser(t *testing.T) {
	store := session.NewMemoryStore()
	record, err := store.CreateSession(context.Background(), "test")
	if err != nil {
		t.Fatal(err)
	}
	observer := NewObserver(store, record.ID)
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"result":{"sessionId":"session-1"}}`))
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"second turn"}]}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"completed"}}}}`))

	// 浏览器收到这个响应后就会认为 prompt() 已经完成。此时历史记录必须已经
	// 包含这一轮对话，这样浏览器随后请求 GET /messages 时才能拿到完整内容。
	if err := observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}`)); err != nil {
		t.Fatal(err)
	}

	messages, err := store.ListMessages(context.Background(), record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Text != "second turn" || messages[1].Text != "completed" {
		t.Fatalf("messages available at prompt completion = %#v", messages)
	}
}

func TestObserverPersistsMultiplePromptsOnOneConnection(t *testing.T) {
	store := session.NewMemoryStore()
	record, err := store.CreateSession(context.Background(), "test")
	if err != nil {
		t.Fatal(err)
	}
	observer := NewObserver(store, record.ID)
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"result":{"sessionId":"session-1"}}`))

	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"first"}]}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"answer one"}}}}`))
	if err := observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}`)); err != nil {
		t.Fatal(err)
	}

	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"second"}]}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"answer two"}}}}`))
	if err := observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}`)); err != nil {
		t.Fatal(err)
	}

	messages, err := store.ListMessages(context.Background(), record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 4 || messages[0].Text != "first" || messages[1].Text != "answer one" || messages[2].Text != "second" || messages[3].Text != "answer two" {
		t.Fatalf("messages = %#v", messages)
	}
	updated, _ := store.GetSession(context.Background(), record.ID)
	if updated.Title != "first" {
		t.Fatalf("title = %q, want first prompt title", updated.Title)
	}
	if updated.ACPSessionID != "session-1" {
		t.Fatalf("session = %q", updated.ACPSessionID)
	}
}

func TestObserverFinalizesPendingSecondPromptOnConnectionClose(t *testing.T) {
	store := session.NewMemoryStore()
	record, err := store.CreateSession(context.Background(), "test")
	if err != nil {
		t.Fatal(err)
	}
	observer := NewObserver(store, record.ID)
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"result":{"sessionId":"session-1"}}`))
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"first"}]}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"answer"}}}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}`))
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"pending"}]}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"partial answer"}}}}`))

	if err := observer.Finalize(context.Background()); err != nil {
		t.Fatal(err)
	}
	messages, err := store.ListMessages(context.Background(), record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 4 || messages[2].Text != "pending" || messages[3].Text != "partial answer" {
		t.Fatalf("messages = %#v", messages)
	}
}

func TestObserverDoesNotPersistReplayedHistoryBeforeNewPrompt(t *testing.T) {
	// session/load 可能重播旧消息；这里只允许新 prompt 产生的回复再次写入数据库。
	store := session.NewMemoryStore()
	record, err := store.CreateSession(context.Background(), "test")
	if err != nil {
		t.Fatal(err)
	}
	observer := NewObserver(store, record.ID)
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":1,"method":"session/load","params":{}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"result":{"sessionId":"session-1"}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"replayed first answer"}}}}`))
	observer.ObserveClient([]byte(`{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"second turn"}]}}`))
	_ = observer.ObserveAgent(context.Background(), []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"second answer"}}}}`))
	if err := observer.Finalize(context.Background()); err != nil {
		t.Fatal(err)
	}

	messages, err := store.ListMessages(context.Background(), record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[1].Text != "second answer" {
		t.Fatalf("messages = %#v", messages)
	}
}
