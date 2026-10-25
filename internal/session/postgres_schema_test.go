package session

import (
	"strings"
	"testing"
)

func TestPostgresSchemaUsesSessionNames(t *testing.T) {
	for _, name := range []string{"sessions", "session_id", "session_leases"} {
		if !strings.Contains(postgresSchema, name) {
			t.Fatalf("postgres schema does not contain %q", name)
		}
	}
	for _, oldName := range []string{"conversations", "conversation_id", "conversation_leases"} {
		if strings.Contains(postgresSchema, oldName) {
			t.Fatalf("postgres schema still contains old name %q", oldName)
		}
	}
}
