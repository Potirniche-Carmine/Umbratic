package supervisor

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"strconv"
	"testing"
	"umbratic-veil-console/internal/config"
)

func proxyTestPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
func TestProxyApplyRollbackEnrollmentAndStop(t *testing.T) {
	binary := os.Getenv("UMBRATIC_TEST_CADDY_BINARY")
	if binary == "" {
		t.Skip("set UMBRATIC_TEST_CADDY_BINARY to test the release Caddy")
	}
	ctx := context.Background()
	initial := config.DefaultConnection()
	initial.Port = proxyTestPort(t)
	p := NewProxy(binary, t.TempDir(), "127.0.0.1:8080", 8177, initial)
	defer p.Stop()
	if err := p.Start(ctx); err != nil {
		t.Fatal(err)
	}
	_, ca, err := p.Enrollment()
	if err != nil || len(ca) == 0 {
		t.Fatalf("enrollment CA missing: %v", err)
	}
	candidate := initial
	candidate.Host = "127.0.0.1"
	candidate.Port = proxyTestPort(t)
	saved := initial
	if err := p.Apply(ctx, candidate, func(c config.Connection) error { saved = c; return nil }); err != nil {
		t.Fatal(err)
	}
	if saved != candidate {
		t.Fatal("candidate not persisted")
	}
	enrolled, nextCA, err := p.Enrollment()
	if err != nil || enrolled != candidate || !bytes.Equal(ca, nextCA) {
		t.Fatalf("enrollment drift: %+v %v", enrolled, err)
	}
	candidate.Port = proxyTestPort(t)
	if err := p.Apply(ctx, candidate, func(config.Connection) error { return errors.New("disk full") }); err == nil {
		t.Fatal("save failure accepted")
	}
	if current, ready := p.Snapshot(); current != saved || !ready {
		t.Fatalf("rollback failed: %+v %v", current, ready)
	}
	if err := p.probe(ctx, saved); err != nil {
		t.Fatalf("previous HTTPS not serving after rollback: %v", err)
	}
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	candidate.Port = occupied.Addr().(*net.TCPAddr).Port
	err = p.Apply(ctx, candidate, func(config.Connection) error { t.Error("persisted failed listener"); return nil })
	occupied.Close()
	if err == nil {
		t.Fatal("occupied port accepted")
	}
	if current, ready := p.Snapshot(); current != saved || !ready {
		t.Fatal("port conflict did not restore prior connection")
	}
	p.Stop()
	if _, _, err := p.Enrollment(); err == nil {
		t.Fatal("enrollment allowed after stop")
	}
	if err := p.Start(ctx); err == nil {
		t.Fatal("shutdown allowed new child")
	}
	l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(saved.Port)))
	if err != nil {
		t.Fatalf("proxy left listener after shutdown: %v", err)
	}
	l.Close()
}
