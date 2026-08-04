package model

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

// blockingReader delivers one chunk, then blocks until released.
type blockingReader struct {
	first    []byte
	sent     bool
	released chan struct{}
}

func (r *blockingReader) Read(p []byte) (int, error) {
	if !r.sent {
		r.sent = true
		return copy(p, r.first), nil
	}
	<-r.released
	return copy(p, []byte("late")), nil
}

func TestIdleReaderNeverWritesIntoTheCallerBufferAfterReadReturns(t *testing.T) {
	released := make(chan struct{})
	defer close(released)
	src := &blockingReader{first: []byte("early"), released: released}
	reader := withIdleAndCancel(context.Background(), src, 50*time.Millisecond)

	buffer := make([]byte, 16)
	n, err := reader.Read(buffer)
	if err != nil || string(buffer[:n]) != "early" {
		t.Fatalf("first read: %q %v", buffer[:n], err)
	}

	// The source is now blocked, so this read must time out. The buffer belongs to
	// the caller again the moment Read returns; nothing may write into it later.
	if _, err := reader.Read(buffer); !errors.As(err, &ProviderError{}) {
		t.Fatalf("expected a provider timeout, got %v", err)
	}
	copy(buffer, bytes.Repeat([]byte("x"), len(buffer)))
	time.Sleep(50 * time.Millisecond)
	if string(buffer) != string(bytes.Repeat([]byte("x"), len(buffer))) {
		t.Fatalf("the reader wrote into the caller's buffer after Read returned: %q", buffer)
	}
}

func TestIdleReaderDeliversChunksLargerThanTheCallerBuffer(t *testing.T) {
	reader := withIdleAndCancel(context.Background(), bytes.NewReader([]byte("alpha bravo")), time.Second)
	var out []byte
	small := make([]byte, 4)
	for {
		n, err := reader.Read(small)
		out = append(out, small[:n]...)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if string(out) != "alpha bravo" {
		t.Fatalf("stream was not reassembled: %q", out)
	}
}
