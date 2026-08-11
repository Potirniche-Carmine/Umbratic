package config

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"umbratic-veil/internal/model"
)

// ModelEntry is one model this Veil can route a chat request to. The registry
// is always populated: with VEIL_MODELS unset it holds exactly one entry
// synthesized from the single-model variables, so every code path downstream
// reads the same shape whether or not an administrator configured a fleet.
type ModelEntry struct {
	ID              string `json:"id"`
	ProviderBaseURL string `json:"provider_base_url"`
	Display         string `json:"display"`
	Reasoning       bool   `json:"reasoning"`
	ContextLength   int    `json:"context_length"`
}

// MaxModelIDBytes bounds a registry id. Ids travel in chat bodies and in
// /api/models, and a longer one is a configuration mistake rather than a model.
const MaxModelIDBytes = 256

type Config struct {
	Addr                string
	AuthToken           string
	ControlToken        string
	CompanyIdentityMode bool
	EntitlementPath     string
	IdentityStorePath   string
	Mode                model.Mode
	ProviderBaseURL     string
	DefaultModel        string
	// Models is the routing registry, always at least one entry.
	Models []ModelEntry
	// ModelSelectionEnabled is true only when VEIL_MODELS was set. It gates the
	// chat.model_selection feature name, and with it whether a client may name a
	// model at all — an unset registry keeps rejecting `model` loudly.
	ModelSelectionEnabled  bool
	ContextLength          int
	MaxOutputTokens        int
	ModelParallelToolCalls bool
	Generation             model.GenerationProfile
	ModelVision            bool
	ModelReasoning         bool
	TemplateRegistryPath   string
	TelemetryEnabled       bool
	TelemetryStorePath     string
	TelemetryRetentionDays int
	TelemetryMaxBodyBytes  int64
	ModelTimeout           time.Duration
	RequestTimeout         time.Duration
	StreamIdleTimeout      time.Duration
	MaxBodyBytes           int64
	RAG                    RAG
	// Networks whose X-Forwarded-For header may be believed. Empty by default,
	// so an unconfigured deployment keys rate limits on the immediate peer
	// rather than on a header any client can forge.
	TrustedProxyCIDRs []netip.Prefix
}

// parseTrustedProxyCIDRs reads the comma-separated CIDR allowlist that decides
// whether X-Forwarded-For is believed. Bare addresses are accepted as
// single-host prefixes.
func parseTrustedProxyCIDRs(value string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, entry := range strings.Split(value, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if prefix, err := netip.ParsePrefix(entry); err == nil {
			prefixes = append(prefixes, prefix)
			continue
		}
		address, err := netip.ParseAddr(entry)
		if err != nil {
			return nil, fmt.Errorf("VEIL_TRUSTED_PROXY_CIDRS entry %q is not an address or CIDR", entry)
		}
		prefixes = append(prefixes, netip.PrefixFrom(address, address.BitLen()))
	}
	return prefixes, nil
}

func Load() (Config, error) {
	envFile := envString("VEIL_ENV_FILE", ".env")
	if envFile != "-" {
		if err := loadDotEnv(envFile); err != nil {
			return Config{}, err
		}
	}

	mode, err := model.ParseMode(os.Getenv("VEIL_MODE"))
	if err != nil {
		return Config{}, err
	}

	modelTimeout, err := envDuration("VEIL_MODEL_TIMEOUT", 180*time.Second)
	if err != nil {
		return Config{}, err
	}
	requestTimeout, err := envDuration("VEIL_REQUEST_TIMEOUT", 195*time.Second)
	if err != nil {
		return Config{}, err
	}
	streamIdleTimeout, err := envDuration("VEIL_STREAM_IDLE_TIMEOUT", 60*time.Second)
	if err != nil {
		return Config{}, err
	}
	maxBodyBytes, err := envInt64("VEIL_MAX_BODY_BYTES", 64<<20)
	if err != nil {
		return Config{}, err
	}
	telemetryMaxBodyBytes, err := envInt64("VEIL_TELEMETRY_MAX_BODY_BYTES", 16<<20)
	if err != nil {
		return Config{}, err
	}
	contextLength, err := envInt("VEIL_CONTEXT_LENGTH", 0)
	if err != nil {
		return Config{}, err
	}
	maxOutputTokens, err := envInt("VEIL_MAX_OUTPUT_TOKENS", 8192)
	if err != nil {
		return Config{}, err
	}
	telemetryEnabled, err := envBool("VEIL_TELEMETRY_ENABLED", true)
	if err != nil {
		return Config{}, err
	}
	companyIdentityMode, err := envBool("VEIL_COMPANY_IDENTITY_MODE", false)
	if err != nil {
		return Config{}, err
	}
	modelVision, err := envBool("VEIL_MODEL_VISION", false)
	if err != nil {
		return Config{}, err
	}
	modelReasoning, err := envBool("VEIL_MODEL_REASONING", false)
	if err != nil {
		return Config{}, err
	}
	trustedProxyCIDRs, err := parseTrustedProxyCIDRs(os.Getenv("VEIL_TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return Config{}, err
	}

	telemetryRetentionDays, err := envInt("VEIL_TELEMETRY_RETENTION_DAYS", 30)
	if err != nil {
		return Config{}, err
	}

	ragConfig, err := loadRAG()
	if err != nil {
		return Config{}, err
	}

	var generation model.GenerationProfile
	if mode == model.ModeLocal {
		generation = model.LocalGenerationProfile(maxOutputTokens)
	} else {
		generation, err = loadServerGenerationProfile(maxOutputTokens)
		if err != nil {
			return Config{}, err
		}
	}

	cfg := Config{
		Addr:                   envString("VEIL_ADDR", "127.0.0.1:8080"),
		TrustedProxyCIDRs:      trustedProxyCIDRs,
		AuthToken:              strings.TrimSpace(os.Getenv("VEIL_AUTH_TOKEN")),
		ControlToken:           strings.TrimSpace(os.Getenv("VEIL_CONTROL_TOKEN")),
		CompanyIdentityMode:    companyIdentityMode,
		EntitlementPath:        strings.TrimSpace(os.Getenv("VEIL_ENTITLEMENT_PATH")),
		IdentityStorePath:      strings.TrimSpace(os.Getenv("VEIL_IDENTITY_STORE_PATH")),
		Mode:                   mode,
		ProviderBaseURL:        strings.TrimSpace(os.Getenv("VEIL_PROVIDER_BASE_URL")),
		DefaultModel:           strings.TrimSpace(os.Getenv("VEIL_MODEL")),
		ContextLength:          contextLength,
		MaxOutputTokens:        generation.MaxOutputTokens,
		ModelParallelToolCalls: generation.ParallelToolCalls,
		Generation:             generation,
		ModelVision:            modelVision,
		ModelReasoning:         modelReasoning,
		TemplateRegistryPath:   strings.TrimSpace(os.Getenv("VEIL_TEMPLATE_REGISTRY_PATH")),
		TelemetryEnabled:       telemetryEnabled,
		TelemetryStorePath:     strings.TrimSpace(os.Getenv("VEIL_TELEMETRY_STORE_PATH")),
		TelemetryRetentionDays: telemetryRetentionDays,
		TelemetryMaxBodyBytes:  telemetryMaxBodyBytes,
		ModelTimeout:           modelTimeout,
		RequestTimeout:         requestTimeout,
		StreamIdleTimeout:      streamIdleTimeout,
		MaxBodyBytes:           maxBodyBytes,
		RAG:                    ragConfig,
	}

	if cfg.AuthToken == "" {
		return Config{}, errors.New("VEIL_AUTH_TOKEN is required")
	}
	if cfg.CompanyIdentityMode {
		if cfg.ControlToken == "" {
			return Config{}, errors.New("VEIL_CONTROL_TOKEN is required in company identity mode")
		}
		if cfg.ControlToken == cfg.AuthToken {
			return Config{}, errors.New("VEIL_CONTROL_TOKEN must differ from VEIL_AUTH_TOKEN")
		}
		if cfg.EntitlementPath == "" {
			return Config{}, errors.New("VEIL_ENTITLEMENT_PATH is required in company identity mode")
		}
		if cfg.IdentityStorePath == "" {
			return Config{}, errors.New("VEIL_IDENTITY_STORE_PATH is required in company identity mode")
		}
	}
	if cfg.ProviderBaseURL == "" {
		return Config{}, errors.New("VEIL_PROVIDER_BASE_URL is required")
	}
	if cfg.DefaultModel == "" {
		return Config{}, errors.New("VEIL_MODEL is required")
	}
	if cfg.ModelTimeout <= 0 {
		return Config{}, errors.New("VEIL_MODEL_TIMEOUT must be positive")
	}
	if cfg.RequestTimeout <= 0 {
		return Config{}, errors.New("VEIL_REQUEST_TIMEOUT must be positive")
	}
	if cfg.StreamIdleTimeout <= 0 {
		return Config{}, errors.New("VEIL_STREAM_IDLE_TIMEOUT must be positive")
	}
	if cfg.MaxBodyBytes <= 0 {
		return Config{}, errors.New("VEIL_MAX_BODY_BYTES must be positive")
	}
	if cfg.ContextLength < 0 {
		return Config{}, errors.New("VEIL_CONTEXT_LENGTH must be positive when set")
	}
	if cfg.TelemetryRetentionDays <= 0 {
		return Config{}, errors.New("VEIL_TELEMETRY_RETENTION_DAYS must be positive")
	}
	if cfg.TelemetryMaxBodyBytes <= 0 {
		return Config{}, errors.New("VEIL_TELEMETRY_MAX_BODY_BYTES must be positive")
	}
	if err := cfg.Generation.Validate(); err != nil {
		return Config{}, err
	}
	if err := loadModelRegistry(&cfg); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

// loadModelRegistry fills cfg.Models. Unset VEIL_MODELS synthesizes the
// single-model registry, which is what keeps an existing deployment byte
// identical: one entry, no chat.model_selection, `model` still refused.
func loadModelRegistry(cfg *Config) error {
	raw := strings.TrimSpace(os.Getenv("VEIL_MODELS"))
	if raw == "" {
		cfg.Models = []ModelEntry{{
			ID:              cfg.DefaultModel,
			ProviderBaseURL: cfg.ProviderBaseURL,
			Reasoning:       cfg.ModelReasoning,
			ContextLength:   cfg.ContextLength,
		}}
		cfg.ModelSelectionEnabled = false
		return nil
	}
	if cfg.Mode != model.ModeServer {
		return errors.New("VEIL_MODELS is a server-mode setting")
	}

	var entries []ModelEntry
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entries); err != nil {
		return errors.New("VEIL_MODELS must be a JSON array of model entries")
	}
	if len(entries) == 0 {
		return errors.New("VEIL_MODELS must list at least one model")
	}

	seen := make(map[string]bool, len(entries))
	for index := range entries {
		entry := &entries[index]
		entry.ID = strings.TrimSpace(entry.ID)
		entry.Display = strings.TrimSpace(entry.Display)
		entry.ProviderBaseURL = strings.TrimSpace(entry.ProviderBaseURL)
		if entry.ID == "" {
			return fmt.Errorf("VEIL_MODELS entry %d is missing id", index)
		}
		if len(entry.ID) > MaxModelIDBytes {
			return fmt.Errorf("VEIL_MODELS entry %q has an id longer than %d bytes", entry.ID, MaxModelIDBytes)
		}
		if seen[entry.ID] {
			return fmt.Errorf("VEIL_MODELS lists id %q twice", entry.ID)
		}
		seen[entry.ID] = true
		if entry.ProviderBaseURL == "" {
			return fmt.Errorf("VEIL_MODELS entry %q is missing provider_base_url", entry.ID)
		}
		parsed, err := url.Parse(entry.ProviderBaseURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return fmt.Errorf("VEIL_MODELS entry %q has an invalid provider_base_url", entry.ID)
		}
		if entry.ContextLength < 0 {
			return fmt.Errorf("VEIL_MODELS entry %q has a negative context_length", entry.ID)
		}
	}
	if !seen[cfg.DefaultModel] {
		return errors.New("VEIL_MODEL must name one of the VEIL_MODELS ids")
	}

	cfg.Models = entries
	cfg.ModelSelectionEnabled = true
	return nil
}

// ModelEntryByID returns the registry entry for an id.
func (c Config) ModelEntryByID(id string) (ModelEntry, bool) {
	for _, entry := range c.Models {
		if entry.ID == id {
			return entry, true
		}
	}
	return ModelEntry{}, false
}

// ModelIDs returns the routable ids in registry order.
func (c Config) ModelIDs() []string {
	ids := make([]string, 0, len(c.Models))
	for _, entry := range c.Models {
		ids = append(ids, entry.ID)
	}
	return ids
}

func loadServerGenerationProfile(maxOutputTokens int) (model.GenerationProfile, error) {
	temperature, err := envFloat("VEIL_TEMPERATURE", 0.2)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	topP, err := envFloat("VEIL_TOP_P", 0.95)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	parallelToolCalls, err := envBool("VEIL_MODEL_PARALLEL_TOOL_CALLS", true)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	reasoningEffort, err := model.ParseReasoningEffort(os.Getenv("VEIL_REASONING_EFFORT"))
	if err != nil {
		return model.GenerationProfile{}, err
	}
	thinkingBudget, err := envOptionalNonNegInt("VEIL_THINKING_TOKEN_BUDGET")
	if err != nil {
		return model.GenerationProfile{}, err
	}
	maxConcurrent, err := envInt("VEIL_MAX_CONCURRENT_REQUESTS", 32)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	maxConcurrentUser, err := envInt("VEIL_MAX_CONCURRENT_REQUESTS_PER_USER", 4)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	queueTimeout, err := envDuration("VEIL_QUEUE_TIMEOUT", 30*time.Second)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	return model.GenerationProfile{
		Temperature:               temperature,
		TopP:                      topP,
		MaxOutputTokens:           maxOutputTokens,
		ReasoningEffort:           reasoningEffort,
		ThinkingTokenBudget:       thinkingBudget,
		ParallelToolCalls:         parallelToolCalls,
		MaxConcurrentRequests:     maxConcurrent,
		MaxConcurrentRequestsUser: maxConcurrentUser,
		QueueTimeout:              queueTimeout,
	}, nil
}

func envString(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func envDuration(name string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(value)
	if err == nil {
		return duration, nil
	}
	seconds, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be a duration like 60s or a number of seconds", name)
	}
	return time.Duration(seconds) * time.Second, nil
}

func envInt64(name string, fallback int64) (int64, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return parsed, nil
}

func envInt(name string, fallback int) (int, error) {
	value, err := envInt64(name, int64(fallback))
	return int(value), err
}

func envOptionalNonNegInt(name string) (*int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return nil, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return nil, fmt.Errorf("%s must be an integer", name)
	}
	if parsed < 0 {
		return nil, fmt.Errorf("%s must be non-negative", name)
	}
	return &parsed, nil
}

func envFloat(name string, fallback float64) (float64, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a number", name)
	}
	return parsed, nil
}

func envBool(name string, fallback bool) (bool, error) {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	if value == "" {
		return fallback, nil
	}
	switch value {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be true or false", name)
	}
}

func loadDotEnv(filePath string) error {
	file, err := os.Open(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("invalid .env line %q", line)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		if key == "" {
			return fmt.Errorf("invalid .env line %q", line)
		}
		if _, exists := os.LookupEnv(key); !exists {
			if err := os.Setenv(key, value); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}
