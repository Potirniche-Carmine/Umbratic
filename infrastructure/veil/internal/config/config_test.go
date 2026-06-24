package config

import (
	"testing"
	"time"
)

func setRequiredEnv(t *testing.T) {
	t.Helper()
	t.Setenv("VEIL_ENV_FILE", "testdata/missing.env")
	t.Setenv("VEIL_AUTH_TOKEN", "token")
	t.Setenv("VEIL_PROVIDER_PROTOCOL", "")
	t.Setenv("VEIL_PROVIDER_BASE_URL", "http://provider.test")
	t.Setenv("VEIL_PROVIDER_CHAT_PATH", "")
	t.Setenv("VEIL_PROVIDER_ENDPOINT_PATH", "")
	t.Setenv("VEIL_PROVIDER_MODELS_PATH", "")
	t.Setenv("VEIL_PROVIDER_MODELS_ENDPOINT_PATH", "")
	t.Setenv("VEIL_MODEL", "default-model")
	t.Setenv("VEIL_MODEL_TIMEOUT", "")
	t.Setenv("VEIL_REQUEST_TIMEOUT", "")
	t.Setenv("VEIL_MAX_BODY_BYTES", "")
}

func TestLoadRequiresAuthToken(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_AUTH_TOKEN", "")

	_, err := Load()
	if err == nil {
		t.Fatal("expected missing auth token error")
	}
}

func TestLoadUsesConfiguredModel(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_PROVIDER_PROTOCOL", "ollama")
	t.Setenv("VEIL_PROVIDER_ENDPOINT_PATH", "/api/chat")
	t.Setenv("VEIL_PROVIDER_MODELS_ENDPOINT_PATH", "/api/tags")
	t.Setenv("VEIL_MODEL_TIMEOUT", "12s")
	t.Setenv("VEIL_REQUEST_TIMEOUT", "20")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProviderProtocol != "ollama" {
		t.Fatalf("unexpected provider protocol %q", cfg.ProviderProtocol)
	}
	if cfg.ProviderChatEndpointPath != "/api/chat" {
		t.Fatalf("unexpected endpoint path %q", cfg.ProviderChatEndpointPath)
	}
	if cfg.ProviderModelsEndpointPath != "/api/tags" {
		t.Fatalf("unexpected models endpoint path %q", cfg.ProviderModelsEndpointPath)
	}
	if cfg.DefaultModel != "default-model" {
		t.Fatalf("unexpected default model %q", cfg.DefaultModel)
	}
	if cfg.ModelTimeout != 12*time.Second || cfg.RequestTimeout != 20*time.Second {
		t.Fatalf("unexpected timeouts: %s %s", cfg.ModelTimeout, cfg.RequestTimeout)
	}
}

func TestLoadRequiresConfiguredModel(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MODEL", "")

	_, err := Load()
	if err == nil {
		t.Fatal("expected missing model error")
	}
}

func TestLoadRejectsInvalidTimeout(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MODEL_TIMEOUT", "soon")

	_, err := Load()
	if err == nil {
		t.Fatal("expected invalid timeout error")
	}
}
