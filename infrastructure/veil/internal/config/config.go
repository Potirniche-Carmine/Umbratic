package config

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
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
	ID               string                  `json:"id"`
	ProviderBaseURL  string                  `json:"provider_base_url"`
	Display          string                  `json:"display"`
	Reasoning        bool                    `json:"reasoning"`
	ReasoningEfforts []string                `json:"reasoning_efforts"`
	SamplingProfiles *model.SamplingProfiles `json:"sampling_profiles,omitempty"`
	ContextLength    int                     `json:"context_length"`
}

// MaxModelIDBytes bounds a registry id. Ids travel in chat bodies and in
// /api/models, and a longer one is a configuration mistake rather than a model.
const MaxModelIDBytes = 256

type Config struct {
	Image               *model.ImageRuntime
	Addr                string
	AuthToken           string
	ControlToken        string
	CompanyIdentityMode bool
	EntitlementPath     string
	IdentityStorePath   string
	Mode                model.Mode
	ProviderBaseURL     string
	// ProviderAPIKey is the bearer sent to the model runtime. In local mode the
	// desktop mints one per app run, so the llama-server it started answers only
	// to the Veil it started alongside.
	ProviderAPIKey string
	DefaultModel   string
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
	// identity, which admission control does not: concurrency limits how much
	// work runs at once, not how often one client may ask. Zero disables.
	ModelRequestsPerMinute int
	ModelTimeout           time.Duration
	RequestTimeout         time.Duration
	StreamIdleTimeout      time.Duration
	MaxBodyBytes           int64
	// SpeechBaseURL and SpeechModel address the transcription runtime that backs
	// dictation. Both empty is the normal case: a deployment without them has no
	// /api/transcribe route and withholds the feature name, rather than
	// advertising a capability that would fail on first use.
	SpeechBaseURL string
	SpeechModel   string
	// SpeechAPIKey is optional. A Console-managed vLLM speech model on the
	// company's own network needs none; the desktop's llama-server sidecar is
	// started with a per-run key and will refuse a call without it.
	SpeechAPIKey string
	// WebSearchUsagePath is where the organization's monthly search ledger is
	// written, and WebSearchRequestsPerMinute bounds how often one user may
	// search. The rate is its own limiter rather than a share of the model one:
	// a lookup is cheap next to a generation, and letting research spend the
	// chat budget would make a well-used tool run the turn out of quota.
	WebSearchUsagePath         string
	WebSearchRequestsPerMinute int
	RAG                        RAG
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
	maxBodyBytes, err := envInt64("VEIL_MAX_BODY_BYTES", 24<<20)
	if err != nil {
		return Config{}, err
	}
	modelRequestsPerMinute, err := envInt("VEIL_MODEL_REQUESTS_PER_MINUTE", 120)
	if err != nil {
		return Config{}, err
	}
	webSearchRequestsPerMinute, err := envInt("VEIL_WEB_SEARCH_REQUESTS_PER_MINUTE", 20)
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

	ragConfig, err := loadRAG()
	if err != nil {
		return Config{}, err
	}

	identityStorePath := strings.TrimSpace(os.Getenv("VEIL_IDENTITY_STORE_PATH"))

	var generation model.GenerationProfile
	if mode == model.ModeLocal {
		generation, err = loadLocalGenerationProfile(maxOutputTokens)
		if err != nil {
			return Config{}, err
		}
	} else {
		generation, err = loadServerGenerationProfile(maxOutputTokens)
		if err != nil {
			return Config{}, err
		}
	}

	cfg := Config{
		Addr:                       envString("VEIL_ADDR", "127.0.0.1:8080"),
		TrustedProxyCIDRs:          trustedProxyCIDRs,
		AuthToken:                  strings.TrimSpace(os.Getenv("VEIL_AUTH_TOKEN")),
		ControlToken:               strings.TrimSpace(os.Getenv("VEIL_CONTROL_TOKEN")),
		CompanyIdentityMode:        companyIdentityMode,
		EntitlementPath:            strings.TrimSpace(os.Getenv("VEIL_ENTITLEMENT_PATH")),
		IdentityStorePath:          identityStorePath,
		Mode:                       mode,
		ProviderBaseURL:            strings.TrimSpace(os.Getenv("VEIL_PROVIDER_BASE_URL")),
		ProviderAPIKey:             strings.TrimSpace(os.Getenv("VEIL_PROVIDER_API_KEY")),
		DefaultModel:               strings.TrimSpace(os.Getenv("VEIL_MODEL")),
		ContextLength:              contextLength,
		MaxOutputTokens:            generation.MaxOutputTokens,
		ModelParallelToolCalls:     generation.ParallelToolCalls,
		Generation:                 generation,
		ModelVision:                modelVision,
		ModelReasoning:             modelReasoning,
		TemplateRegistryPath:       strings.TrimSpace(os.Getenv("VEIL_TEMPLATE_REGISTRY_PATH")),
		ModelRequestsPerMinute:     modelRequestsPerMinute,
		SpeechBaseURL:              strings.TrimRight(strings.TrimSpace(os.Getenv("VEIL_SPEECH_BASE_URL")), "/"),
		SpeechModel:                strings.TrimSpace(os.Getenv("VEIL_SPEECH_MODEL")),
		SpeechAPIKey:               strings.TrimSpace(os.Getenv("VEIL_SPEECH_API_KEY")),
		WebSearchUsagePath:         webSearchUsagePath(identityStorePath),
		WebSearchRequestsPerMinute: webSearchRequestsPerMinute,
		ModelTimeout:               modelTimeout,
		RequestTimeout:             requestTimeout,
		StreamIdleTimeout:          streamIdleTimeout,
		MaxBodyBytes:               maxBodyBytes,
		RAG:                        ragConfig,
	}

	if err := validateBindAddress(cfg.Addr); err != nil {
		return Config{}, err
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
	if cfg.DefaultModel == "" && cfg.Mode != model.ModeServer {
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
	if cfg.ModelRequestsPerMinute < 0 {
		return Config{}, errors.New("VEIL_MODEL_REQUESTS_PER_MINUTE must not be negative")
	}
	if cfg.WebSearchRequestsPerMinute < 0 {
		return Config{}, errors.New("VEIL_WEB_SEARCH_REQUESTS_PER_MINUTE must not be negative")
	}
	if err := cfg.Generation.Validate(); err != nil {
		return Config{}, err
	}
	if err := loadModelRegistry(&cfg); err != nil {
		return Config{}, err
	}
	cfg.Image, err = loadImageRuntime()
	if err != nil {
		return Config{}, err
	}
	if err := validateSpeech(&cfg); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

// SpeechEnabled reports whether this deployment can transcribe. It gates both
// the route and the advertised feature name, so the two can never disagree.
func (c Config) SpeechEnabled() bool {
	return c.SpeechBaseURL != "" && c.SpeechModel != ""
}

// webSearchUsagePath resolves where the monthly search ledger is written. It
// defaults beside the identity store because that is the one directory a
// company deployment already keeps writable state in. A deployment without an
// identity store has no monthly cap to enforce either, so its ledger lands in
// the working directory and only records what was spent.
func webSearchUsagePath(identityStorePath string) string {
	if configured := strings.TrimSpace(os.Getenv("VEIL_WEB_SEARCH_USAGE_PATH")); configured != "" {
		return configured
	}
	if identityStorePath != "" {
		return filepath.Join(filepath.Dir(identityStorePath), "web-search-usage.json")
	}
	return "web-search-usage.json"
}

// validateSpeech refuses a half-configured runtime. Setting one variable and
// not the other is always a mistake, and silently disabling dictation would
// send the administrator looking for the fault in the client.
func validateSpeech(cfg *Config) error {
	if cfg.SpeechBaseURL == "" && cfg.SpeechModel == "" {
		return nil
	}
	if cfg.SpeechBaseURL == "" {
		return errors.New("VEIL_SPEECH_BASE_URL is required when VEIL_SPEECH_MODEL is set")
	}
	if cfg.SpeechModel == "" {
		return errors.New("VEIL_SPEECH_MODEL is required when VEIL_SPEECH_BASE_URL is set")
	}
	if len(cfg.SpeechModel) > MaxModelIDBytes {
		return fmt.Errorf("VEIL_SPEECH_MODEL is longer than %d bytes", MaxModelIDBytes)
	}
	parsed, err := url.Parse(cfg.SpeechBaseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return errors.New("VEIL_SPEECH_BASE_URL must be an http or https URL")
	}
	return nil
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
		if entry.SamplingProfiles != nil {
			if err := entry.SamplingProfiles.Validate(); err != nil {
				return err
			}
		}
		seenEfforts := map[string]bool{}
		for _, effort := range entry.ReasoningEfforts {
			if !model.ValidReasoningLevel(effort) || effort == "none" || seenEfforts[effort] || len(entry.ReasoningEfforts) > 16 {
				return errors.New("VEIL_MODELS has invalid reasoning options")
			}
			seenEfforts[effort] = true
		}
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

// loadLocalGenerationProfile takes the fixed local profile and lets the desktop
// override the sampling on top of it.
//
// Only the sampling: the concurrency and queue numbers describe one desktop
// serving one person and are not the launcher's business. Every override
// defaults to the fixed profile's own value, so a desktop that sets none of
// them gets exactly what local mode has always done.
func loadLocalGenerationProfile(maxOutputTokens int) (model.GenerationProfile, error) {
	profile := model.LocalGenerationProfile(maxOutputTokens)
	temperature, err := envFloat("VEIL_TEMPERATURE", profile.Temperature)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	topP, err := envFloat("VEIL_TOP_P", profile.TopP)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	topK, err := envInt("VEIL_TOP_K", profile.TopK)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	minP, err := envFloat("VEIL_MIN_P", profile.MinP)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	presencePenalty, err := envFloat("VEIL_PRESENCE_PENALTY", profile.PresencePenalty)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	repetitionPenalty, err := envFloat("VEIL_REPETITION_PENALTY", profile.RepetitionPenalty)
	if err != nil {
		return model.GenerationProfile{}, err
	}
	reasoningEffort, err := model.ParseReasoningEffort(os.Getenv("VEIL_REASONING_EFFORT"))
	if err != nil {
		return model.GenerationProfile{}, err
	}
	profile.Temperature = temperature
	profile.TopP = topP
	profile.TopK = topK
	profile.MinP = minP
	profile.PresencePenalty = presencePenalty
	profile.RepetitionPenalty = repetitionPenalty
	profile.ReasoningEffort = reasoningEffort
	return profile, nil
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

// validateBindAddress refuses a public bind unless the operator has said a TLS
// proxy is in front. Veil speaks plain HTTP by design — the shipped deployment
// terminates TLS in Caddy and proxies to loopback — so a non-loopback VEIL_ADDR
// set by mistake would serve every prompt and session token in cleartext. The
// failure has to be loud at startup rather than silent on the wire.
func validateBindAddress(addr string) error {
	host, _, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return errors.New("VEIL_ADDR must be host:port")
	}
	host = strings.TrimSpace(host)
	if host == "" {
		host = "0.0.0.0"
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || ip.Unmap().IsLoopback() {
		return nil
	}
	if allowed, err := envBool("VEIL_ALLOW_EXTERNAL_BIND", false); err != nil || allowed {
		return err
	}
	return errors.New("VEIL_ADDR binds outside loopback; Veil serves plain HTTP and expects a TLS proxy in front. " +
		"Set VEIL_ALLOW_EXTERNAL_BIND=1 only when something else terminates TLS")
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
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer in the platform range", name)
	}
	return parsed, nil
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
