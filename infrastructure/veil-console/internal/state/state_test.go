package state

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"umbratic-veil-console/internal/auth"
)

func TestLegacyProviderKeyIsRemovedFromSecretStore(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	path := filepath.Join(dir, "secrets.json")
	legacy := []byte(`{"veil_token":"veil-token","provider_key":"remove-me","csrf_key":"csrf-key"}`)
	if err := os.WriteFile(path, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LoadOrCreateSecrets(); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(payload, []byte("provider_key")) || bytes.Contains(payload, []byte("remove-me")) {
		t.Fatal("legacy provider key remains in the secret store")
	}
}

func TestSetupIsOneUseAndSessionsPersist(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1000, 0)
	code, err := store.NewSetup(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	verifier, _ := auth.HashPassword("a long setup password")
	if err := store.CreateOwner(ctx, code, "owner", verifier, now); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateOwner(ctx, code, "other", verifier, now); err == nil {
		t.Fatal("setup code replay succeeded")
	}
	token, _, err := store.CreateSession(ctx, "owner", now)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.Session(ctx, token, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
}

func TestSetupExpires(t *testing.T) {
	ctx := context.Background()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Unix(1000, 0)
	code, _ := store.NewSetup(ctx, now)
	verifier, _ := auth.HashPassword("a long setup password")
	if err := store.CreateOwner(ctx, code, "owner", verifier, now.Add(16*time.Minute)); err == nil {
		t.Fatal("expired code succeeded")
	}
}

func TestExclusiveStateLock(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := Open(dir); err == nil {
		second.Close()
		t.Fatal("second store acquired state lock")
	}
}

func TestStaleStateLockFileDoesNotBlock(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "console.lock"), []byte("12345\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := Open(dir)
	if err != nil {
		t.Fatalf("stale lock file blocked the state directory: %v", err)
	}
	defer store.Close()
}

func TestSessionIdleAndAbsoluteExpiry(t *testing.T) {
	ctx := context.Background()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Unix(1000, 0)
	idleToken, _, _ := store.CreateSession(ctx, "owner", now)
	if _, err := store.Session(ctx, idleToken, now.Add(9*time.Minute)); err != nil {
		t.Fatal("active session expired before the idle timeout")
	}
	if _, err := store.Session(ctx, idleToken, now.Add(20*time.Minute)); err == nil {
		t.Fatal("idle session did not expire")
	}
	absoluteToken, _, _ := store.CreateSession(ctx, "owner", now)
	for step := time.Minute; step < SessionAbsoluteTimeout; step += 5 * time.Minute {
		_, _ = store.Session(ctx, absoluteToken, now.Add(step))
	}
	if _, err := store.Session(ctx, absoluteToken, now.Add(SessionAbsoluteTimeout)); err == nil {
		t.Fatal("absolute session did not expire")
	}
}
