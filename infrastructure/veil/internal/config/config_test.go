package config

import (
	"os"
	"path/filepath"
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
	t.Setenv("VEIL_CONTEXT_LENGTH", "")
	t.Setenv("VEIL_TEMPLATE_REGISTRY_PATH", "")
	t.Setenv("VEIL_TELEMETRY_ENABLED", "")
	t.Setenv("VEIL_TELEMETRY_STORE_PATH", "")
	t.Setenv("VEIL_TELEMETRY_RETENTION_DAYS", "")
	t.Setenv("VEIL_TELEMETRY_MAX_BODY_BYTES", "")
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
	t.Setenv("VEIL_CONTEXT_LENGTH", "64000")

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
	if cfg.ContextLength != 64000 {
		t.Fatalf("unexpected context length %d", cfg.ContextLength)
	}
	if cfg.TemplateRegistryPath != "" {
		t.Fatalf("unexpected template registry path %q", cfg.TemplateRegistryPath)
	}
	if !cfg.TelemetryEnabled || cfg.TelemetryRetentionDays != 30 || cfg.TelemetryStorePath != "" || cfg.TelemetryMaxBodyBytes != 16<<20 {
		t.Fatalf("unexpected telemetry defaults: %#v", cfg)
	}
	if cfg.ModelTimeout != 12*time.Second || cfg.RequestTimeout != 20*time.Second {
		t.Fatalf("unexpected timeouts: %s %s", cfg.ModelTimeout, cfg.RequestTimeout)
	}
}

func TestLoadUsesConfiguredTemplateRegistryPath(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_TEMPLATE_REGISTRY_PATH", "/srv/veil/templates.json")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TemplateRegistryPath != "/srv/veil/templates.json" {
		t.Fatalf("unexpected template registry path %q", cfg.TemplateRegistryPath)
	}
}

func TestLoadUsesConfiguredTelemetryPolicy(t *testing.T) {
	setRequiredEnv(t)
	storePath := filepath.Join(t.TempDir(), "telemetry")
	t.Setenv("VEIL_TELEMETRY_ENABLED", "false")
	t.Setenv("VEIL_TELEMETRY_STORE_PATH", storePath)
	t.Setenv("VEIL_TELEMETRY_RETENTION_DAYS", "14")
	t.Setenv("VEIL_TELEMETRY_MAX_BODY_BYTES", "8388608")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TelemetryEnabled {
		t.Fatal("expected telemetry to be disabled by admin policy")
	}
	if cfg.TelemetryStorePath != storePath {
		t.Fatalf("unexpected telemetry store path %q", cfg.TelemetryStorePath)
	}
	if cfg.TelemetryRetentionDays != 14 {
		t.Fatalf("unexpected retention days %d", cfg.TelemetryRetentionDays)
	}
	if cfg.TelemetryMaxBodyBytes != 8388608 {
		t.Fatalf("unexpected telemetry body limit %d", cfg.TelemetryMaxBodyBytes)
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

func unsetEnv(t *testing.T, name string) {
	t.Helper()
	value, existed := os.LookupEnv(name)
	if err := os.Unsetenv(name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(name, value)
			return
		}
		_ = os.Unsetenv(name)
	})
}

func TestLoadRejectsInvalidTimeout(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MODEL_TIMEOUT", "soon")

	_, err := Load()
	if err == nil {
		t.Fatal("expected invalid timeout error")
	}
}

func TestLoadRejectsInvalidMaxBodyBytes(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MAX_BODY_BYTES", "not-a-number")

	_, err := Load()
	if err == nil {
		t.Fatal("expected invalid max body error")
	}
}

func TestLoadRejectsInvalidContextLength(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_CONTEXT_LENGTH", "-1")

	_, err := Load()
	if err == nil {
		t.Fatal("expected invalid context length error")
	}
}

func TestLoadRejectsInvalidTelemetryPolicy(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_TELEMETRY_ENABLED", "sometimes")

	_, err := Load()
	if err == nil {
		t.Fatal("expected invalid telemetry enabled error")
	}

	setRequiredEnv(t)
	t.Setenv("VEIL_TELEMETRY_RETENTION_DAYS", "0")
	_, err = Load()
	if err == nil {
		t.Fatal("expected invalid telemetry retention error")
	}

	setRequiredEnv(t)
	t.Setenv("VEIL_TELEMETRY_MAX_BODY_BYTES", "0")
	_, err = Load()
	if err == nil {
		t.Fatal("expected invalid telemetry body limit error")
	}
}

func TestLoadRequiresProviderBaseURL(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_PROVIDER_BASE_URL", "")

	_, err := Load()
	if err == nil {
		t.Fatal("expected missing provider base URL error")
	}
}

func TestLoadRejectsUnsupportedProviderProtocol(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_PROVIDER_PROTOCOL", "raw-runtime")

	_, err := Load()
	if err == nil {
		t.Fatal("expected unsupported provider protocol error")
	}
}

func TestLoadDotEnvPopulatesMissingValuesWithoutOverridingProcessEnv(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("VEIL_AUTH_TOKEN=from-file\nVEIL_MODEL=file-model\nVEIL_PROVIDER_BASE_URL=http://from-file.test\nVEIL_ADDR=0.0.0.0:9000\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("VEIL_ENV_FILE", envPath)
	t.Setenv("VEIL_AUTH_TOKEN", "from-process")
	unsetEnv(t, "VEIL_ADDR")
	unsetEnv(t, "VEIL_MODEL")
	unsetEnv(t, "VEIL_PROVIDER_BASE_URL")
	t.Setenv("VEIL_PROVIDER_PROTOCOL", "")
	t.Setenv("VEIL_MODEL_TIMEOUT", "")
	t.Setenv("VEIL_REQUEST_TIMEOUT", "")
	t.Setenv("VEIL_MAX_BODY_BYTES", "")
	t.Setenv("VEIL_TELEMETRY_MAX_BODY_BYTES", "")
	t.Setenv("VEIL_PROVIDER_CHAT_PATH", "")
	t.Setenv("VEIL_PROVIDER_ENDPOINT_PATH", "")
	t.Setenv("VEIL_PROVIDER_MODELS_PATH", "")
	t.Setenv("VEIL_PROVIDER_MODELS_ENDPOINT_PATH", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AuthToken != "from-process" {
		t.Fatalf("dotenv overrode process env token: %q", cfg.AuthToken)
	}
	if cfg.DefaultModel != "file-model" || cfg.ProviderBaseURL != "http://from-file.test" || cfg.Addr != "0.0.0.0:9000" {
		t.Fatalf("dotenv values were not loaded: %#v", cfg)
	}
}
