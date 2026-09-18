package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// dockerImageReference accepts registry/repository:tag@digest shapes and
// nothing else — no flags, no paths, no whitespace — because the value is
// spliced into a docker run argument list.
var dockerImageReference = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]*$`)

type Startup struct {
	ModelsDir   string
	CaddyBinary string
	Listen      string
	Port        int
	StateDir    string
	VeilBinary  string
	// VLLMBinary is the vLLM executable Console launches managed models with.
	// Optional: without it the Models page renders read-only, because there is
	// nothing to start.
	VLLMBinary string
	// VLLMDockerImage launches managed models as `docker run` of this vLLM
	// OpenAI-server image instead of a host binary. The card command stays the
	// single source of truth; Console wraps it with the GPU, cache-mount, and
	// loopback port-publish flags. Mutually exclusive with VLLMBinary.
	VLLMDockerImage string
	VeilAddress     string
	EntitlementPath string
	TrustedOrigin   string
}

type ReasoningEffort string

const (
	ReasoningNone   ReasoningEffort = "none"
	ReasoningLow    ReasoningEffort = "low"
	ReasoningMedium ReasoningEffort = "medium"
	ReasoningHigh   ReasoningEffort = "high"
)

type Veil struct {
	ProviderBaseURL              string
	Model                        string
	ContextLength                int
	MaxOutputTokens              int
	Temperature                  float64
	TopP                         float64
	ReasoningEffort              ReasoningEffort
	ThinkingTokenBudget          *int
	ParallelToolCalls            bool
	MaxConcurrentRequests        int
	MaxConcurrentRequestsPerUser int
	QueueTimeout                 time.Duration
	ModelTimeout                 time.Duration
	RequestTimeout               time.Duration
	MaxBodyBytes                 int64
}

func DefaultVeil() Veil {
	return Veil{
		ProviderBaseURL: "http://127.0.0.1:8000/v1",
		MaxOutputTokens: DefaultMaxOutputTokens,
		// Sampling that no longer comes from a form has to come from
		// somewhere. These are the fallback for a model the catalog has no card
		// for; a catalog model overwrites them with its own on registration.
		Temperature:                  0.7,
		TopP:                         0.95,
		ReasoningEffort:              ReasoningNone,
		ParallelToolCalls:            true,
		MaxConcurrentRequests:        32,
		MaxConcurrentRequestsPerUser: 4,
		QueueTimeout:                 30 * time.Second,
		ModelTimeout:                 60 * time.Second,
		RequestTimeout:               75 * time.Second,
		MaxBodyBytes:                 DefaultMaxBodyBytes,
	}
}

func ValidateStartup(cfg *Startup) error {
	if cfg.Listen != "127.0.0.1" && cfg.Listen != "::1" {
		return errors.New("listen address must be 127.0.0.1 or ::1")
	}
	if cfg.Port < 1 || cfg.Port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	if err := validateTrustedOrigin(cfg.TrustedOrigin); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.StateDir) == "" {
		return errors.New("state directory is required")
	}
	stateDir, err := filepath.Abs(cfg.StateDir)
	if err != nil {
		return fmt.Errorf("resolve state directory: %w", err)
	}
	cfg.StateDir = filepath.Clean(stateDir)
	binary, err := filepath.Abs(cfg.VeilBinary)
	if err != nil {
		return fmt.Errorf("resolve Veil binary: %w", err)
	}
	binary, err = resolveBinaryPath(binary)
	if err != nil {
		return fmt.Errorf("resolve Veil binary: %w", err)
	}
	info, err := os.Lstat(binary)
	if err != nil {
		return fmt.Errorf("inspect Veil binary: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Veil binary must be a regular file")
	}
	if unsafePermissions(info.Mode()) {
		return errors.New("Veil binary must not be group or world writable")
	}
	if unsafeOwner(info) {
		return errors.New("Veil binary owner is unsafe")
	}
	cfg.VeilBinary = filepath.Clean(binary)
	if err := validateOptionalBinary(&cfg.VLLMBinary, "vLLM binary"); err != nil {
		return err
	}
	if err := validateOptionalBinary(&cfg.CaddyBinary, "Caddy binary"); err != nil {
		return err
	}
	cfg.VLLMDockerImage = strings.TrimSpace(cfg.VLLMDockerImage)
	if cfg.VLLMDockerImage != "" {
		if cfg.VLLMBinary != "" {
			return errors.New("choose either --vllm-binary or --vllm-docker-image, not both")
		}
		if len(cfg.VLLMDockerImage) > 256 || !dockerImageReference.MatchString(cfg.VLLMDockerImage) {
			return errors.New("vLLM Docker image must be a plain image reference such as vllm/vllm-openai:v0.28.0")
		}
	}
	if cfg.EntitlementPath != "" {
		entitlementPath, err := filepath.Abs(cfg.EntitlementPath)
		if err != nil {
			return fmt.Errorf("resolve entitlement path: %w", err)
		}
		info, err := os.Lstat(entitlementPath)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("entitlement must be a regular file")
		}
		if unsafePermissions(info.Mode()) {
			return errors.New("entitlement must not be group or world writable")
		}
		cfg.EntitlementPath = filepath.Clean(entitlementPath)
	}
	host, port, err := net.SplitHostPort(cfg.VeilAddress)
	if err != nil || (host != "127.0.0.1" && host != "::1") {
		return errors.New("Veil address must be a loopback host and port")
	}
	parsedPort, err := strconv.Atoi(port)
	if err != nil || parsedPort < 1 || parsedPort > 65535 {
		return errors.New("Veil address must use a valid port")
	}
	return nil
}

// validateOptionalBinary holds an optional executable to the same bar as the
// Veil binary: a real file, not a symlink, not group or world writable, and
// owned safely. A launcher is only as trustworthy as what it launches.
func validateOptionalBinary(path *string, label string) error {
	if strings.TrimSpace(*path) == "" {
		*path = ""
		return nil
	}
	resolved, err := filepath.Abs(*path)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", label, err)
	}
	resolved, err = resolveBinaryPath(resolved)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", label, err)
	}
	info, err := os.Lstat(resolved)
	if err != nil {
		return fmt.Errorf("inspect %s: %w", label, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s must be a regular file", label)
	}
	if unsafePermissions(info.Mode()) {
		return fmt.Errorf("%s must not be group or world writable", label)
	}
	if unsafeOwner(info) {
		return fmt.Errorf("%s owner is unsafe", label)
	}
	*path = filepath.Clean(resolved)
	return nil
}

func validateTrustedOrigin(origin string) error {
	if origin == "" {
		return nil
	}
	parsed, err := url.ParseRequestURI(origin)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return errors.New("trusted origin must be an absolute HTTPS origin")
	}
	if parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("trusted origin must not contain credentials, a path, query, or fragment")
	}
	return nil
}

func ParseReasoningEffort(value string) (ReasoningEffort, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "none":
		return ReasoningNone, nil
	case "low":
		return ReasoningLow, nil
	case "medium":
		return ReasoningMedium, nil
	case "high":
		return ReasoningHigh, nil
	default:
		return "", fmt.Errorf("reasoning effort must be none, low, medium, or high")
	}
}

func (v Veil) Validate() error {
	parsed, err := url.ParseRequestURI(strings.TrimSpace(v.ProviderBaseURL))
	if err != nil || parsed.Hostname() == "" {
		return errors.New("provider URL must include a valid host")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("provider URL must use http or https")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return errors.New("provider URL must not contain credentials or a fragment")
	}
	if len(v.Model) > 256 || strings.ContainsAny(v.Model, "\r\n\x00") {
		return errors.New("model is required and must be 256 characters or fewer")
	}
	if v.ContextLength < 0 || v.ContextLength > 1_048_576 {
		return errors.New("context length must be between 1 and 1048576")
	}
	if v.MaxOutputTokens < 1 || v.MaxOutputTokens > 32768 {
		return errors.New("maximum output tokens must be between 1 and 32768")
	}
	if v.Temperature < 0 || v.Temperature > 2 {
		return errors.New("temperature must be between 0.0 and 2.0")
	}
	if v.TopP <= 0 || v.TopP > 1 {
		return errors.New("top p must be greater than 0.0 and at most 1.0")
	}
	switch v.ReasoningEffort {
	case ReasoningNone, ReasoningLow, ReasoningMedium, ReasoningHigh:
	default:
		return errors.New("reasoning effort must be none, low, medium, or high")
	}
	if v.ThinkingTokenBudget != nil {
		if *v.ThinkingTokenBudget < 0 {
			return errors.New("thinking token budget must be non-negative")
		}
		if *v.ThinkingTokenBudget > v.MaxOutputTokens {
			return errors.New("thinking token budget must not exceed maximum output tokens")
		}
	}
	if v.MaxConcurrentRequests < 1 {
		return errors.New("maximum concurrent requests must be at least 1")
	}
	if v.MaxConcurrentRequestsPerUser < 1 {
		return errors.New("maximum concurrent requests per user must be at least 1")
	}
	if v.MaxConcurrentRequestsPerUser > v.MaxConcurrentRequests {
		return errors.New("maximum concurrent requests per user must not exceed maximum concurrent requests")
	}
	if v.QueueTimeout < time.Second || v.QueueTimeout > 15*time.Minute {
		return errors.New("queue timeout is outside the supported range")
	}
	if v.ModelTimeout < time.Second || v.ModelTimeout > 10*time.Minute || v.RequestTimeout < time.Second || v.RequestTimeout > 15*time.Minute {
		return errors.New("timeouts are outside the supported range")
	}
	if v.MaxBodyBytes < 1024 || v.MaxBodyBytes > 256<<20 {
		return errors.New("maximum body size must be between 1024 and 268435456 bytes")
	}
	return nil
}

func (v Veil) Environment(veilAddress, token string) []string {
	values := []string{
		"VEIL_ENV_FILE=-",
		"VEIL_ADDR=" + veilAddress,
		"VEIL_AUTH_TOKEN=" + token,
		"VEIL_MODE=server",
		"VEIL_PROVIDER_BASE_URL=" + v.ProviderBaseURL,
		"VEIL_MODEL=" + v.Model,
		"VEIL_MAX_OUTPUT_TOKENS=" + strconv.Itoa(v.MaxOutputTokens),
		"VEIL_TEMPERATURE=" + formatFloat(v.Temperature),
		"VEIL_TOP_P=" + formatFloat(v.TopP),
		"VEIL_REASONING_EFFORT=" + string(v.ReasoningEffort),
		"VEIL_MODEL_PARALLEL_TOOL_CALLS=" + strconv.FormatBool(v.ParallelToolCalls),
		"VEIL_MAX_CONCURRENT_REQUESTS=" + strconv.Itoa(v.MaxConcurrentRequests),
		"VEIL_MAX_CONCURRENT_REQUESTS_PER_USER=" + strconv.Itoa(v.MaxConcurrentRequestsPerUser),
		"VEIL_QUEUE_TIMEOUT=" + v.QueueTimeout.String(),
		"VEIL_MODEL_TIMEOUT=" + v.ModelTimeout.String(),
		"VEIL_REQUEST_TIMEOUT=" + v.RequestTimeout.String(),
		"VEIL_MAX_BODY_BYTES=" + strconv.FormatInt(v.MaxBodyBytes, 10),
		"VEIL_TELEMETRY_ENABLED=false",
	}
	if v.ThinkingTokenBudget != nil {
		values = append(values, "VEIL_THINKING_TOKEN_BUDGET="+strconv.Itoa(*v.ThinkingTokenBudget))
	}
	if v.ContextLength > 0 {
		values = append(values, "VEIL_CONTEXT_LENGTH="+strconv.Itoa(v.ContextLength))
	}
	return values
}

func formatFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func (v Veil) CompanyEnvironment(veilAddress, internalToken, controlToken, entitlementPath, identityStorePath string) []string {
	values := v.Environment(veilAddress, internalToken)
	values = append(values,
		// Veil listens on loopback behind Caddy, which overwrites
		// X-Forwarded-For. Without this, every identity rate limit would key on
		// the proxy and apply to the whole organization at once.
		"VEIL_TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128",
		"VEIL_COMPANY_IDENTITY_MODE=true",
		"VEIL_CONTROL_TOKEN="+controlToken,
		"VEIL_ENTITLEMENT_PATH="+entitlementPath,
		"VEIL_IDENTITY_STORE_PATH="+identityStorePath,
	)
	return values
}
