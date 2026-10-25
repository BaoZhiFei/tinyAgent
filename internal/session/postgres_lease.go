package session

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type postgresLease struct {
	pool       *pgxpool.Pool
	id, holder string
}

func (l postgresLease) Release(ctx context.Context) error {
	// 删除时必须带上 holder：旧请求超时后晚一步释放，也不能删掉新请求的租约。
	_, err := l.pool.Exec(ctx, `delete from session_leases where session_id=$1 and holder=$2`, l.id, l.holder)
	return err
}
