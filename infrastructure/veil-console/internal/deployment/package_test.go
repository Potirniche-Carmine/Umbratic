package deployment

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestPackageRejectsTamperingUncheckedAndMissingFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "deploy.sh")
	data := []byte("reviewed installer")
	if err := os.WriteFile(path, data, 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{"deploy.sh": fmt.Sprintf("%x", sha256.Sum256(data))}
	if err := VerifyFiles(dir, files); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("tampered"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := VerifyFiles(dir, files); err == nil {
		t.Fatal("accepted tampered installer")
	}
	_ = os.WriteFile(path, data, 0700)
	_ = os.WriteFile(filepath.Join(dir, "unchecked"), data, 0600)
	if err := VerifyFiles(dir, files); err == nil {
		t.Fatal("accepted unchecked input")
	}
	_ = os.Remove(filepath.Join(dir, "unchecked"))
	_ = os.Remove(path)
	if err := VerifyFiles(dir, files); err == nil {
		t.Fatal("accepted missing input")
	}
}
func TestDeploymentRejectsUnsafeConfig(t *testing.T) {
	base := Config{OS: "darwin", Arch: "arm64", Profile: "metal", ConsolePort: 8177, VeilPort: 8080}
	if err := base.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Config){func(c *Config) { c.ConsolePort = c.VeilPort }, func(c *Config) { c.Profile = "cuda" }, func(c *Config) { c.Arch = "amd64" }} {
		c := base
		change(&c)
		if c.Validate() == nil {
			t.Fatalf("accepted invalid config: %+v", c)
		}
	}
}
