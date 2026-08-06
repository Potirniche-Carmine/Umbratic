package main

import (
	"os"
	"syscall"
	"testing"
	"time"
)

// The orphaned-Veil bug: Electron force-killed by a dev script never runs its
// before-quit hook, so the signal that stops Veil is never sent and the process
// keeps its port for the rest of the session. The inherited stdin pipe closes on
// every exit path, so EOF has to produce the same shutdown a signal would.
func TestParentStdinEOFRequestsShutdown(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()

	original := os.Stdin
	os.Stdin = read
	t.Setenv(ParentStdinWatchEnv, "1")
	defer func() { os.Stdin = original }()

	shutdown := make(chan os.Signal, 1)
	watchParentStdin(shutdown)

	// A live launcher holds the pipe open and writes nothing.
	select {
	case <-shutdown:
		t.Fatal("shutdown was requested while the launcher was still alive")
	case <-time.After(50 * time.Millisecond):
	}

	// Losing the launcher closes the write end.
	if err := write.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case sig := <-shutdown:
		if sig != syscall.SIGTERM {
			t.Fatalf("expected the drain path, got %v", sig)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stdin EOF did not request shutdown")
	}
}

// Opt-in only: a Veil started by hand has a stdin that either never reaches EOF
// or reaches it immediately, and neither should stop the server.
func TestParentStdinWatchIsOptIn(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()

	original := os.Stdin
	os.Stdin = read
	t.Setenv(ParentStdinWatchEnv, "")
	defer func() { os.Stdin = original }()

	shutdown := make(chan os.Signal, 1)
	watchParentStdin(shutdown)
	if err := write.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-shutdown:
		t.Fatal("stdin EOF stopped a Veil that never opted in")
	case <-time.After(100 * time.Millisecond):
	}
}
