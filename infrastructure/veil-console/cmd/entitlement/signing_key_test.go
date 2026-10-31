package main

import (
	"bytes"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"umbratic-veil-console/internal/entitlement"
)

func TestSigningKeyCreatesOnceAndReuses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release", "signing.key")
	first, created, err := signingKey(path)
	if err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	seed, err := base64.RawURLEncoding.DecodeString(string(first))
	if err != nil || len(seed) != 32 {
		t.Fatal("invalid seed")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("unsafe key permissions")
	}
	second, created, err := signingKey(path)
	if err != nil || created || !bytes.Equal(first, second) {
		t.Fatal("existing key was replaced")
	}
	doc, public, err := entitlement.Sign(entitlement.Payload{Version: 1, OrgUID: "org_testcustomer", MaxAuthorizedUsers: 10, MaxDevicesPerUser: 2}, string(second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entitlement.Verify(doc, public); err != nil {
		t.Fatal(err)
	}
}
func TestSigningKeyDoesNotReplaceInvalidFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "signing.key")
	if err := os.WriteFile(path, []byte("invalid-existing-key"), 0600); err != nil {
		t.Fatal(err)
	}
	data, created, err := signingKey(path)
	if err != nil || created || string(data) != "invalid-existing-key" {
		t.Fatal("invalid key was silently rotated")
	}
	if _, _, err := signingKey(filepath.Dir(path)); err == nil {
		t.Fatal("directory accepted as key")
	}
}

func TestDeploymentPolicyNeedsOnlyAdministratorSigningKey(t *testing.T) {
	dir := t.TempDir()
	outputPath := filepath.Join(dir, "entitlement.json")
	keyPath := filepath.Join(dir, "private", "signing.key")
	command := exec.Command("go", "run", ".", "--output", outputPath, "--private-key-file", keyPath, "--seats", "10", "--devices-per-user", "2")
	var public bytes.Buffer
	command.Stdout = &public
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		t.Fatalf("administrator-generated policy: %v %s", err, stderr.String())
	}
	document, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	key := strings.TrimSpace(public.String())
	if strings.Contains(key, "\n") {
		t.Fatal("command emitted something other than its public key")
	}
	payload, err := entitlement.Verify(document, key)
	if err != nil || payload.MaxAuthorizedUsers != 10 || payload.MaxDevicesPerUser != 2 {
		t.Fatalf("signed deployment policy: %+v %v", payload, err)
	}
}
