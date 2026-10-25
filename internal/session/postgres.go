// 本文件是线上保存数据的实现；它与 store.go 中的 MemoryStore 共享 Store 接口。
// MemoryStore 只适合单进程测试，这里则要让多个 API 副本同时工作时仍然看到一致的数据。
package session

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore 把 session、网页消息和租约保存到 PostgreSQL。
// 它保存网页要显示的数据和 ACP session ID，但不保存 Codex 的会话文件；文件仍由 AgenticFS 管理。
type PostgresStore struct{ pool *pgxpool.Pool }

const postgresSchema = `
create extension if not exists pgcrypto;
create table if not exists sessions (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    agent_session_id text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create table if not exists messages (
    session_id uuid not null references sessions(id) on delete cascade,
    sequence integer not null,
    role text not null check (role in ('user','assistant')),
    text text not null,
    created_at timestamptz not null default now(),
    primary key(session_id, sequence)
);
create table if not exists session_leases (
    session_id uuid primary key references sessions(id) on delete cascade,
    holder text not null,
    expires_at timestamptz not null
);`

// OpenPostgres 打开数据库连接池，并创建演示所需的最小表结构。
func OpenPostgres(ctx context.Context, url string) (*PostgresStore, error) {
	// 打开连接池后立即建表，确保后续 HTTP 请求开始时表已经准备好。
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	store := &PostgresStore{pool: pool}
	if err := store.Migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

// Close 关闭数据库连接池。服务退出前应调用它，避免留下未关闭的数据库连接。
func (s *PostgresStore) Close() { s.pool.Close() }

// Migrate 创建可以重复执行的最小表结构；正式迁移文件也必须与这里保持一致。
func (s *PostgresStore) Migrate(ctx context.Context) error {
	// 建表语句使用 IF NOT EXISTS，服务重启时可以安全重复执行；正式迁移文件必须与这里保持一致。
	_, err := s.pool.Exec(ctx, postgresSchema)
	return err
}

// GetSession 返回指定 session 的基本信息，供每次 prompt 决定新建还是恢复 ACP session。
func (s *PostgresStore) GetSession(ctx context.Context, id string) (Session, error) {
	var session Session
	err := s.pool.QueryRow(ctx, `select id::text,title,agent_session_id,created_at,updated_at from sessions where id=$1`, id).Scan(&session.ID, &session.Title, &session.ACPSessionID, &session.CreatedAt, &session.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrSessionNotFound
	}
	return session, err
}

// ListSessions 只返回左侧历史列表需要的基本信息；消息由另一个接口按需读取。
func (s *PostgresStore) ListSessions(ctx context.Context) ([]Session, error) {
	rows, err := s.pool.Query(ctx, `select id::text,title,agent_session_id,created_at,updated_at from sessions order by updated_at desc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// 空结果也保持为非 nil，调用方可以直接遍历，JSON 也会稳定编码成 []。
	result := make([]Session, 0)
	for rows.Next() {
		var session Session
		if err := rows.Scan(&session.ID, &session.Title, &session.ACPSessionID, &session.CreatedAt, &session.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, session)
	}
	return result, rows.Err()
}
func (s *PostgresStore) CreateSession(ctx context.Context, title string) (Session, error) {
	// 只创建网页 session 的基本信息；真正的 ACP 会话要等用户第一次提问时才建立。
	// ID 由 PostgreSQL 统一生成，避免多个 API 副本各自生成编号而发生冲突。
	var c Session
	err := s.pool.QueryRow(ctx, `insert into sessions(title) values($1) returning id::text,title,agent_session_id,created_at,updated_at`, title).Scan(&c.ID, &c.Title, &c.ACPSessionID, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

// SetTitle 更新网页历史列表中显示的标题。
func (s *PostgresStore) SetTitle(ctx context.Context, id, title string) error {
	command, err := s.pool.Exec(ctx, `update sessions set title=$2,updated_at=now() where id=$1`, id, title)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrSessionNotFound
	}
	return nil
}

func (s *PostgresStore) ListMessages(ctx context.Context, id string) ([]Message, error) {
	// 按 sequence 读取消息，确保数据库返回顺序和浏览器看到的对话顺序一致。
	rows, err := s.pool.Query(ctx, `select session_id::text,sequence,role,text,created_at from messages where session_id=$1 order by sequence`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// 新 session 没有消息是正常状态；返回空数组而不是 nil，避免 JSON 变成 null。
	result := make([]Message, 0)
	for rows.Next() {
		var m Message
		var role string
		if err := rows.Scan(&m.SessionID, &m.Sequence, &role, &m.Text, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.Role = Role(role)
		result = append(result, m)
	}
	return result, rows.Err()
}
func (s *PostgresStore) AppendMessage(ctx context.Context, m Message) error {
	// 分配消息序号、写入消息和更新 session 时间放在同一事务内，
	// 这样不会出现消息写进去了但列表时间没更新，或列表更新了却没有消息的半完成状态。
	transaction, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer transaction.Rollback(ctx)
	if m.Sequence == 0 {
		err := transaction.QueryRow(ctx, `select coalesce(max(sequence),0)+1 from messages where session_id=$1`, m.SessionID).Scan(&m.Sequence)
		if err != nil {
			return err
		}
	}
	if _, err := transaction.Exec(ctx, `insert into messages(session_id,sequence,role,text,created_at) values($1,$2,$3,$4,coalesce($5,now()))`, m.SessionID, m.Sequence, string(m.Role), m.Text, m.CreatedAt); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `update sessions set updated_at=now() where id=$1`, m.SessionID); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}
func (s *PostgresStore) SaveACPSession(ctx context.Context, id, session string) error {
	// 这里只保存 ACP 返回的编号，不复制 AgenticFS 中的会话文件。
	_, err := s.pool.Exec(ctx, `update sessions set agent_session_id=$2,updated_at=now() where id=$1`, id, session)
	return err
}
func (s *PostgresStore) AcquireLease(ctx context.Context, id, holder string, d time.Duration) (Lease, error) {
	// 一个 session 只有一行租约。已有租约过期时可以接管，同一个 holder 再来时可以续租，
	// 其他仍有效的 holder 则拿不到租约。
	tag, err := s.pool.Exec(ctx, `insert into session_leases(session_id,holder,expires_at) values($1,$2,now()+$3::interval) on conflict(session_id) do update set holder=excluded.holder,expires_at=excluded.expires_at where session_leases.expires_at<now() or session_leases.holder=excluded.holder`, id, holder, d.String())
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, ErrSessionBusy
	}
	return postgresLease{pool: s.pool, id: id, holder: holder}, nil
}
