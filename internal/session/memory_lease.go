package session

import (
	"context"
	"time"
)

type memoryLease struct {
	holder    string
	expiresAt time.Time
}

type memoryLeaseHandle struct {
	store      *MemoryStore
	id, holder string
}

func (l *memoryLeaseHandle) Release(_ context.Context) error {
	// 只允许原 holder 删除自己的租约。这样旧请求超时后，即使它晚一步结束，
	// 也不会误删新请求刚刚取得的租约。
	l.store.mutex.Lock()
	defer l.store.mutex.Unlock()
	if got, ok := l.store.leases[l.id]; ok && got.holder == l.holder {
		delete(l.store.leases, l.id)
	}
	return nil
}
