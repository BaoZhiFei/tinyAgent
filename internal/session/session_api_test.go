// 这些测试确认 session 存储使用对外约定的 ACP 命名和字段。
package session

import (
	"context"
	"testing"
)

func TestSessionStoreUsesACPNames(t *testing.T) {
	store := NewMemoryStore()
	created, err := store.CreateSession(context.Background(), "演示")
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.ACPSessionID != "" {
		t.Fatalf("created session = %#v", created)
	}
	if err := store.SaveACPSession(context.Background(), created.ID, "acp-session-1"); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.GetSession(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ACPSessionID != "acp-session-1" {
		t.Fatalf("ACP session ID = %q", loaded.ACPSessionID)
	}
}
