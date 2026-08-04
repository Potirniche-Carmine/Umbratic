package model

import (
	"context"
	"io"
	"time"
)

const idleReaderChunkBytes = 32 * 1024

type readerChunk struct {
	data []byte
	err  error
}

// idleAwareReader fails a Read when no bytes arrive within idleTimeout, or when
// ctx is canceled. Each delivered chunk resets the idle timer.
//
// A single pump goroutine owns its own buffer and hands out copies. The caller's
// slice is only ever written by Read itself, so a timeout or cancellation cannot
// leave a goroutine writing into a buffer the caller has already reclaimed.
type idleAwareReader struct {
	ctx         context.Context
	idleTimeout time.Duration
	chunks      <-chan readerChunk
	pending     []byte
	err         error
}

func (r *idleAwareReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	if len(p) == 0 {
		return 0, nil
	}
	if len(r.pending) > 0 {
		n := copy(p, r.pending)
		r.pending = r.pending[n:]
		return n, nil
	}
	if r.err != nil {
		return 0, r.err
	}
	timer := time.NewTimer(r.idleTimeout)
	defer timer.Stop()
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	case <-timer.C:
		return 0, ProviderError{Kind: ProviderFailureTimeout}
	case chunk, ok := <-r.chunks:
		if !ok {
			r.err = io.EOF
			return 0, io.EOF
		}
		if chunk.err != nil {
			r.err = chunk.err
			if len(chunk.data) == 0 {
				return 0, chunk.err
			}
		}
		n := copy(p, chunk.data)
		r.pending = chunk.data[n:]
		return n, nil
	}
}

func withIdleAndCancel(ctx context.Context, src io.Reader, idleTimeout time.Duration) io.Reader {
	if idleTimeout <= 0 {
		idleTimeout = 60 * time.Second
	}
	chunks := make(chan readerChunk, 1)
	go func() {
		defer close(chunks)
		buffer := make([]byte, idleReaderChunkBytes)
		for {
			n, err := src.Read(buffer)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buffer[:n])
				select {
				case chunks <- readerChunk{data: data}:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				select {
				case chunks <- readerChunk{err: err}:
				case <-ctx.Done():
				}
				return
			}
		}
	}()
	return &idleAwareReader{ctx: ctx, idleTimeout: idleTimeout, chunks: chunks}
}
