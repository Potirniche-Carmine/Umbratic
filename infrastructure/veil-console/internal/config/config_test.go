package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartupRejectsPublicListen(t *testing.T) {
	cfg := Startup{Listen: "0.0.0.0", Port: 8177}
	if err := ValidateStartup(&cfg); err == nil || !strings.Contains(err.Error(), "listen") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVeilEnvironmentIsAllowlisted(t *testing.T) {
	t.Setenv("SHOULD_NOT_LEAK", "secret")
	cfg := DefaultVeil()
	cfg.Protocol, cfg.ProviderBaseURL, cfg.Model = "ollama", "http://127.0.0.1:11434", "model"
	env := strings.Join(cfg.Environment("127.0.0.1:8080", "token"), "\n")
	if strings.Contains(env, "SHOULD_NOT_LEAK") || !strings.Contains(env, "VEIL_ENV_FILE=-") || !strings.Contains(env, "VEIL_TELEMETRY_ENABLED=false") {
		t.Fatalf("unsafe environment: %s", env)
	}
}

func TestVLLMContextLengthIsSupported(t *testing.T) {
	cfg := DefaultVeil()
	cfg.Protocol = "vllm"
	cfg.ProviderBaseURL = "http://127.0.0.1:8000/v1"
	cfg.Model = "local-model"
	cfg.ContextLength = 65_536
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	env := strings.Join(cfg.Environment("127.0.0.1:8080", "token"), "\n")
	if !strings.Contains(env, "VEIL_CONTEXT_LENGTH=65536") {
		t.Fatalf("context length is missing from environment: %s", env)
	}
}

func TestValidateStartupResolvesBinary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "veil")
	if err := os.WriteFile(path, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := Startup{Listen: "127.0.0.1", Port: 8177, StateDir: t.TempDir(), VeilBinary: path, VeilAddress: "127.0.0.1:8080"}
	if err := ValidateStartup(&cfg); err != nil {
		t.Fatal(err)
	}
}

func TestTrustedOriginRequiresExactHTTPSOrigin(t *testing.T) {
	for _, origin := range []string{
		"http://console.example.com",
		"https://console.example.com/setup",
		"https://user@console.example.com",
	} {
		if err := validateTrustedOrigin(origin); err == nil {
			t.Errorf("invalid trusted origin was accepted: %s", origin)
		}
	}
	if err := validateTrustedOrigin("https://console.example.com"); err != nil {
		t.Fatalf("valid trusted origin was rejected: %v", err)
	}
}
