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
	t.Setenv("VEIL_CONTROL_TOKEN", "")
	t.Setenv("VEIL_COMPANY_IDENTITY_MODE", "")
	t.Setenv("VEIL_ENTITLEMENT_PATH", "")
	t.Setenv("VEIL_IDENTITY_STORE_PATH", "")
	t.Setenv("VEIL_MODE", "server")
	t.Setenv("VEIL_PROVIDER_BASE_URL", "http://provider.test")
	t.Setenv("VEIL_MODEL", "default-model")
	t.Setenv("VEIL_MODELS", "")
	t.Setenv("VEIL_CONTEXT_LENGTH", "")
	t.Setenv("VEIL_MAX_OUTPUT_TOKENS", "")
	t.Setenv("VEIL_TEMPERATURE", "")
	t.Setenv("VEIL_TOP_P", "")
	t.Setenv("VEIL_REASONING_EFFORT", "")
	t.Setenv("VEIL_THINKING_TOKEN_BUDGET", "")
	t.Setenv("VEIL_MODEL_PARALLEL_TOOL_CALLS", "")
	t.Setenv("VEIL_MAX_CONCURRENT_REQUESTS", "")
	t.Setenv("VEIL_MAX_CONCURRENT_REQUESTS_PER_USER", "")
	t.Setenv("VEIL_QUEUE_TIMEOUT", "")
	t.Setenv("VEIL_MODEL_VISION", "")
	t.Setenv("VEIL_MODEL_REASONING", "")
	t.Setenv("VEIL_TEMPLATE_REGISTRY_PATH", "")
	t.Setenv("VEIL_TELEMETRY_ENABLED", "")
	t.Setenv("VEIL_TELEMETRY_STORE_PATH", "")
	t.Setenv("VEIL_TELEMETRY_RETENTION_DAYS", "")
	t.Setenv("VEIL_TELEMETRY_MAX_BODY_BYTES", "")
	t.Setenv("VEIL_MODEL_TIMEOUT", "")
	t.Setenv("VEIL_REQUEST_TIMEOUT", "")
	t.Setenv("VEIL_MAX_BODY_BYTES", "")
	t.Setenv("VEIL_SPEECH_BASE_URL", "")
	t.Setenv("VEIL_SPEECH_MODEL", "")
}

func TestSpeechIsOffUntilBothVariablesAreSet(t *testing.T) {
	setRequiredEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SpeechEnabled() {
		t.Fatal("dictation must be off by default")
	}

	// Half a configuration is always a mistake. Disabling dictation silently
	// would send the administrator looking for the fault in the client.
	for _, half := range []struct{ baseURL, model string }{
		{"http://127.0.0.1:8010/", ""},
		{"", "qwen3-asr"},
		{"not-a-url", "qwen3-asr"},
		{"ftp://127.0.0.1:8010", "qwen3-asr"},
	} {
		t.Setenv("VEIL_SPEECH_BASE_URL", half.baseURL)
		t.Setenv("VEIL_SPEECH_MODEL", half.model)
		if _, err := Load(); err == nil {
			t.Fatalf("a half-configured speech runtime must refuse to start: %#v", half)
		}
	}

	t.Setenv("VEIL_SPEECH_BASE_URL", "http://127.0.0.1:8010/")
	t.Setenv("VEIL_SPEECH_MODEL", "qwen3-asr")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.SpeechEnabled() {
		t.Fatal("both variables set enables dictation")
	}
	if cfg.SpeechBaseURL != "http://127.0.0.1:8010" {
		t.Fatalf("the trailing slash is trimmed once, at load: %q", cfg.SpeechBaseURL)
	}
}

func TestLoadManagedModeDoesNotReadDotEnv(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("VEIL_MODEL=from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	setRequiredEnv(t)
	t.Setenv("VEIL_ENV_FILE", "-")
	t.Setenv("VEIL_MODEL", "from-process")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultModel != "from-process" {
		t.Fatalf("managed mode read .env: %q", cfg.DefaultModel)
	}
}

func TestLoadRequiresAuthToken(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_AUTH_TOKEN", "")

	_, err := Load()
	if err == nil {
		t.Fatal("expected missing auth token error")
	}
}

func TestLoadCompanyModeRequiresSeparateControlAndIdentityFiles(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_COMPANY_IDENTITY_MODE", "true")
	t.Setenv("VEIL_CONTROL_TOKEN", "control")
	t.Setenv("VEIL_ENTITLEMENT_PATH", "entitlement.json")
	t.Setenv("VEIL_IDENTITY_STORE_PATH", "identity.json")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.CompanyIdentityMode || cfg.ControlToken != "control" {
		t.Fatalf("company identity settings were not loaded: %#v", cfg)
	}
	t.Setenv("VEIL_CONTROL_TOKEN", "token")
	if _, err := Load(); err == nil {
		t.Fatal("shared product and control token was accepted")
	}
}

func TestLoadUsesConfiguredServerMode(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MODE", "server")
	t.Setenv("VEIL_MODEL_TIMEOUT", "12s")
	t.Setenv("VEIL_REQUEST_TIMEOUT", "20")
	t.Setenv("VEIL_CONTEXT_LENGTH", "64000")
	t.Setenv("VEIL_TEMPERATURE", "0.4")
	t.Setenv("VEIL_TOP_P", "0.8")
	t.Setenv("VEIL_REASONING_EFFORT", "medium")
	t.Setenv("VEIL_THINKING_TOKEN_BUDGET", "1024")
	t.Setenv("VEIL_MAX_CONCURRENT_REQUESTS", "16")
	t.Setenv("VEIL_MAX_CONCURRENT_REQUESTS_PER_USER", "2")
	t.Setenv("VEIL_QUEUE_TIMEOUT", "45s")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "server" {
		t.Fatalf("unexpected mode %q", cfg.Mode)
	}
	if cfg.DefaultModel != "default-model" {
		t.Fatalf("unexpected default model %q", cfg.DefaultModel)
	}
	if cfg.ContextLength != 64000 {
		t.Fatalf("unexpected context length %d", cfg.ContextLength)
	}
	if cfg.MaxOutputTokens != 8192 || cfg.MaxBodyBytes != 64<<20 {
		t.Fatalf("unexpected context enforcement defaults: %#v", cfg)
	}
	if cfg.Generation.Temperature != 0.4 || cfg.Generation.TopP != 0.8 {
		t.Fatalf("unexpected generation sampling: %#v", cfg.Generation)
	}
	if cfg.Generation.ReasoningEffort != "medium" || cfg.Generation.ThinkingTokenBudget == nil || *cfg.Generation.ThinkingTokenBudget != 1024 {
		t.Fatalf("unexpected reasoning profile: %#v", cfg.Generation)
	}
	if cfg.Generation.MaxConcurrentRequests != 16 || cfg.Generation.MaxConcurrentRequestsUser != 2 || cfg.Generation.QueueTimeout != 45*time.Second {
		t.Fatalf("unexpected admission profile: %#v", cfg.Generation)
	}
	if !cfg.ModelParallelToolCalls || cfg.ModelVision || cfg.ModelReasoning {
		t.Fatalf("unexpected model capability defaults: %#v", cfg)
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

func TestLoadLocalModeTakesSamplingOverrides(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MODE", "local")
	t.Setenv("VEIL_TEMPERATURE", "1.0")
	t.Setenv("VEIL_TOP_P", "0.95")
	t.Setenv("VEIL_TOP_K", "20")
	t.Setenv("VEIL_MIN_P", "0")
	t.Setenv("VEIL_PRESENCE_PENALTY", "1.5")
	t.Setenv("VEIL_REPETITION_PENALTY", "1")
	t.Setenv("VEIL_REASONING_EFFORT", "high")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "local" {
		t.Fatalf("unexpected mode %q", cfg.Mode)
	}
	if cfg.Generation.Temperature != 1.0 || cfg.Generation.TopP != 0.95 || cfg.Generation.TopK != 20 {
		t.Fatalf("local sampling overrides were dropped: %#v", cfg.Generation)
	}
	if cfg.Generation.PresencePenalty != 1.5 || cfg.Generation.RepetitionPenalty != 1 {
		t.Fatalf("local penalty overrides were dropped: %#v", cfg.Generation)
	}
	if cfg.Generation.ReasoningEffort != "high" {
		t.Fatalf("local reasoning effort was dropped: %#v", cfg.Generation)
	}
	// The admission side of the profile is not the launcher's to set: one
	// desktop serving one person does not need it tuned from outside.
	if cfg.Generation.MaxConcurrentRequests != 4 || cfg.Generation.MaxConcurrentRequestsUser != 2 {
		t.Fatalf("local admission profile should stay fixed: %#v", cfg.Generation)
	}
}

func TestLoadLocalModeDefaultsWithoutOverrides(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MODE", "local")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Generation.Temperature != 0.2 || cfg.Generation.TopP != 0.95 || cfg.Generation.ReasoningEffort != "none" {
		t.Fatalf("unexpected local defaults: %#v", cfg.Generation)
	}
	if cfg.Generation.TopK != 0 || cfg.Generation.MinP != 0 || cfg.Generation.PresencePenalty != 0 || cfg.Generation.RepetitionPenalty != 0 {
		t.Fatalf("unset samplers should stay unset: %#v", cfg.Generation)
	}
}

func TestLoadUsesConfiguredModelCapabilities(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MODEL_PARALLEL_TOOL_CALLS", "false")
	t.Setenv("VEIL_MODEL_VISION", "true")
	t.Setenv("VEIL_MODEL_REASONING", "true")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ModelParallelToolCalls || !cfg.ModelVision || !cfg.ModelReasoning {
		t.Fatalf("unexpected model capabilities: %#v", cfg)
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

func TestLoadRejectsInvalidMaxOutputTokens(t *testing.T) {
	for _, value := range []string{"0", "32769", "invalid"} {
		setRequiredEnv(t)
		t.Setenv("VEIL_MAX_OUTPUT_TOKENS", value)
		if _, err := Load(); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
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

func TestLoadRejectsUnsupportedMode(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MODE", "vllm")

	_, err := Load()
	if err == nil {
		t.Fatal("expected unsupported mode error")
	}
}

func TestLoadRejectsInvalidGenerationProfile(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_TOP_P", "0")
	if _, err := Load(); err == nil {
		t.Fatal("expected top_p of 0 to be rejected")
	}
	setRequiredEnv(t)
	t.Setenv("VEIL_TEMPERATURE", "2.1")
	if _, err := Load(); err == nil {
		t.Fatal("expected temperature above 2 to be rejected")
	}
	setRequiredEnv(t)
	t.Setenv("VEIL_THINKING_TOKEN_BUDGET", "9000")
	t.Setenv("VEIL_MAX_OUTPUT_TOKENS", "1024")
	if _, err := Load(); err == nil {
		t.Fatal("expected thinking budget above max output to be rejected")
	}
}

func TestLoadDotEnvPopulatesMissingValuesWithoutOverridingProcessEnv(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("VEIL_AUTH_TOKEN=from-file\nVEIL_MODEL=file-model\nVEIL_PROVIDER_BASE_URL=http://from-file.test\nVEIL_ADDR=0.0.0.0:9000\nVEIL_MODE=server\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("VEIL_ENV_FILE", envPath)
	t.Setenv("VEIL_AUTH_TOKEN", "from-process")
	unsetEnv(t, "VEIL_ADDR")
	unsetEnv(t, "VEIL_MODEL")
	unsetEnv(t, "VEIL_PROVIDER_BASE_URL")
	unsetEnv(t, "VEIL_MODE")
	t.Setenv("VEIL_MODEL_TIMEOUT", "")
	t.Setenv("VEIL_REQUEST_TIMEOUT", "")
	t.Setenv("VEIL_MAX_BODY_BYTES", "")
	t.Setenv("VEIL_TELEMETRY_MAX_BODY_BYTES", "")
	t.Setenv("VEIL_TEMPERATURE", "")
	t.Setenv("VEIL_TOP_P", "")
	t.Setenv("VEIL_REASONING_EFFORT", "")
	t.Setenv("VEIL_THINKING_TOKEN_BUDGET", "")
	t.Setenv("VEIL_MODEL_PARALLEL_TOOL_CALLS", "")
	t.Setenv("VEIL_MAX_CONCURRENT_REQUESTS", "")
	t.Setenv("VEIL_MAX_CONCURRENT_REQUESTS_PER_USER", "")
	t.Setenv("VEIL_QUEUE_TIMEOUT", "")
	t.Setenv("VEIL_MAX_OUTPUT_TOKENS", "")
	t.Setenv("VEIL_CONTEXT_LENGTH", "")
	t.Setenv("VEIL_MODEL_VISION", "")
	t.Setenv("VEIL_MODEL_REASONING", "")
	t.Setenv("VEIL_TEMPLATE_REGISTRY_PATH", "")
	t.Setenv("VEIL_TELEMETRY_ENABLED", "")
	t.Setenv("VEIL_TELEMETRY_STORE_PATH", "")
	t.Setenv("VEIL_TELEMETRY_RETENTION_DAYS", "")
	t.Setenv("VEIL_CONTROL_TOKEN", "")
	t.Setenv("VEIL_COMPANY_IDENTITY_MODE", "")
	t.Setenv("VEIL_ENTITLEMENT_PATH", "")
	t.Setenv("VEIL_IDENTITY_STORE_PATH", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AuthToken != "from-process" {
		t.Fatalf("dotenv overrode process env token: %q", cfg.AuthToken)
	}
	if cfg.DefaultModel != "file-model" || cfg.ProviderBaseURL != "http://from-file.test" || cfg.Addr != "0.0.0.0:9000" || cfg.Mode != "server" {
		t.Fatalf("dotenv values were not loaded: %#v", cfg)
	}
}
