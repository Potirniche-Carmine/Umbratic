//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func assertPrivateSigningKey(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("unsafe key permissions")
	}
}

func TestSigningKeyRejectsBroadPermissionsWithoutReplacingBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "signing.key")
	if err := os.WriteFile(path, []byte("existing-key"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := signingKey(path); err == nil {
		t.Fatal("broadly readable signing key was accepted")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "existing-key" {
		t.Fatal("rejected signing key was replaced")
	}
}
