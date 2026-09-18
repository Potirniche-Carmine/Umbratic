package main

import (
	"bufio"
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
	"umbratic-veil-console/internal/auth"
	"umbratic-veil-console/internal/state"
)

func TestBootstrapIssuesCodeOnlyOnRequestAndNeverAfterClaim(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("managed deployment uses Unix sockets on Linux and macOS")
	}
	short, err := os.MkdirTemp("", "vc-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(short)
	dir, err := filepath.EvalSymlinks(short)
	if err != nil {
		t.Fatal(err)
	}
	store, err := state.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	listener, err := serveBootstrap(store, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	issue := func() string {
		t.Helper()
		conn, err := net.Dial("unix", filepath.Join(dir, "bootstrap.sock"))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_, _ = conn.Write([]byte("issue\n"))
		code, err := bufio.NewReader(conn).ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		return code[:len(code)-1]
	}
	code := issue()
	verifier, err := auth.HashPassword("a long owner password")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOwner(context.Background(), code, "owner", verifier, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := issue(); got != "claimed" {
		t.Fatal("issued a credential after claim")
	}
}
