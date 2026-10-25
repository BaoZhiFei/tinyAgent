package acpproxy

import "context"

type documentObserver interface {
	ObserveClient([]byte)
	ObserveAgent(context.Context, []byte) error
}
