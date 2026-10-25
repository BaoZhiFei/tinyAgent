package session

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"
)

// MemoryStore 是无需数据库的本地测试实现，数据只存在当前进程内。
type MemoryStore struct {
	mutex    sync.Mutex
	next     int
	sessions map[string]Session
	messages map[string][]Message
	leases   map[string]memoryLease
}

// NewMemoryStore 创建一个没有 session、消息和租约的内存存储。
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{sessions: map[string]Session{}, messages: map[string][]Message{}, leases: map[string]memoryLease{}}
}

// GetSession 读取一段对话的标题、时间和 ACP 会话编号。
func (s *MemoryStore) GetSession(_ context.Context, id string) (Session, error) {
	// 内存实现用一把锁保护所有 map，保证同一个进程里的测试不会同时改坏数据；
	// 它只服务本地测试，多个服务进程之间仍要靠 PostgreSQL 协调。
	s.mutex.Lock()
	defer s.mutex.Unlock()
	session, found := s.sessions[id]
	if !found {
		return Session{}, ErrSessionNotFound
	}
	return session, nil
}

// ListSessions 返回左侧历史列表需要的全部 session，最近更新的排在前面。
func (s *MemoryStore) ListSessions(_ context.Context) ([]Session, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	// 即使没有任何 session，也返回非 nil 空切片；这样 JSON 是 [] 而不是 null，
	// 浏览器可以直接遍历，不需要额外判断。
	result := make([]Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		result = append(result, session)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UpdatedAt.After(result[j].UpdatedAt) })
	return result, nil
}

func (s *MemoryStore) CreateSession(_ context.Context, title string) (Session, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	s.next++
	now := time.Now().UTC()
	session := Session{ID: "session-" + strconv.Itoa(s.next), Title: title, CreatedAt: now, UpdatedAt: now}
	s.sessions[session.ID] = session
	return session, nil
}

// SetTitle 更新网页历史列表中显示的标题。
func (s *MemoryStore) SetTitle(_ context.Context, id, title string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	session, found := s.sessions[id]
	if !found {
		return ErrSessionNotFound
	}
	session.Title = title
	session.UpdatedAt = time.Now().UTC()
	s.sessions[id] = session
	return nil
}

// ListMessages 返回指定 session 的网页消息，并按 Sequence 从小到大排列。
// 返回的是副本，不是内部切片；调用方即使排序或修改结果，也不会改坏存储里的数据。
func (s *MemoryStore) ListMessages(_ context.Context, id string) ([]Message, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if _, found := s.sessions[id]; !found {
		return nil, ErrSessionNotFound
	}
	// 使用 make 而不是 nil 切片，保证内存实现和 PostgreSQL 实现一样，空结果会编码成 []。
	result := make([]Message, len(s.messages[id]))
	copy(result, s.messages[id])
	sort.Slice(result, func(i, j int) bool { return result[i].Sequence < result[j].Sequence })
	return result, nil
}

// AppendMessage 添加一条网页消息，并把 session 的更新时间推进到消息时间。
// Sequence 为零时由存储接着已有消息编号；调用方给了明确编号时则保留它。
func (s *MemoryStore) AppendMessage(_ context.Context, message Message) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	session, found := s.sessions[message.SessionID]
	if !found {
		return ErrSessionNotFound
	}
	if message.CreatedAt.IsZero() {
		message.CreatedAt = time.Now().UTC()
	}
	if message.Sequence == 0 {
		message.Sequence = len(s.messages[message.SessionID]) + 1
	}
	s.messages[message.SessionID] = append(s.messages[message.SessionID], message)
	session.UpdatedAt = message.CreatedAt
	s.sessions[message.SessionID] = session
	return nil
}

// SaveACPSession 保存 ACP session ID，下一次 prompt 才知道该新建会话还是执行 session/load。
func (s *MemoryStore) SaveACPSession(_ context.Context, id, sessionID string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	session, found := s.sessions[id]
	if !found {
		return ErrSessionNotFound
	}
	session.ACPSessionID = sessionID
	session.UpdatedAt = time.Now().UTC()
	s.sessions[id] = session
	return nil
}

// AcquireLease 尝试取得 session 的独占权。别人还没释放时返回 ErrSessionBusy，
// 同一个 holder 再次进入则允许刷新有效期，避免自己的连接被误判为冲突。
func (s *MemoryStore) AcquireLease(_ context.Context, id, holder string, duration time.Duration) (Lease, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if _, found := s.sessions[id]; !found {
		return nil, ErrSessionNotFound
	}
	if existing, ok := s.leases[id]; ok && existing.expiresAt.After(time.Now()) && existing.holder != holder {
		return nil, ErrSessionBusy
	}
	s.leases[id] = memoryLease{holder: holder, expiresAt: time.Now().Add(duration)}
	return &memoryLeaseHandle{store: s, id: id, holder: holder}, nil
}
