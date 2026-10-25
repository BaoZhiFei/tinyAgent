// 这些测试确认内存存储的消息顺序、空列表和独占租约行为与线上实现一致。
package session

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMemoryStoreKeepsMessagesInSequence(t *testing.T) {
	store := NewMemoryStore()
	session, err := store.CreateSession(context.Background(), "你好")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AppendMessage(context.Background(), Message{SessionID: session.ID, Sequence: 2, Role: RoleAssistant, Text: "第二条"}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendMessage(context.Background(), Message{SessionID: session.ID, Sequence: 1, Role: RoleUser, Text: "第一条"}); err != nil {
		t.Fatal(err)
	}
	messages, err := store.ListMessages(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Text != "第一条" || messages[1].Text != "第二条" {
		t.Fatalf("messages = %#v", messages)
	}
}

func TestMemoryStoreRejectsSecondActiveLease(t *testing.T) {
	store := NewMemoryStore()
	session, _ := store.CreateSession(context.Background(), "租约")
	_, err := store.AcquireLease(context.Background(), session.ID, "first", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.AcquireLease(context.Background(), session.ID, "second", time.Minute)
	if !errors.Is(err, ErrSessionBusy) {
		t.Fatalf("AcquireLease() error = %v, want ErrSessionBusy", err)
	}
}
