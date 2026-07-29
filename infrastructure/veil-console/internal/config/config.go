package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Startup struct {
	Listen          string
	Port            int
	StateDir        string
	VeilBinary      string
	VeilAddress     string
	EntitlementPath string
	TrustedOrigin   string
}

type Veil struct {
	Protocol        string
	ProviderBaseURL string
	Model           string
	ContextLength   int
	MaxOutputTokens int
	ModelTimeout    time.Duration
	RequestTimeout  time.Duration
	MaxBodyBytes    int64
}

func DefaultVeil() Veil {
	return Veil{MaxOutputTokens: 8192, ModelTimeout: 60 * time.Second, RequestTimeout: 75 * time.Second, MaxBodyBytes: 64 << 20}
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

func (v Veil) Validate() error {
	if v.Protocol != "ollama" && v.Protocol != "vllm" {
		return errors.New("provider protocol must be ollama or vllm")
	}
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
	if strings.TrimSpace(v.Model) == "" || len(v.Model) > 256 || strings.ContainsAny(v.Model, "\r\n\x00") {
		return errors.New("model is required and must be 256 characters or fewer")
	}
	if v.ContextLength < 0 || v.ContextLength > 1_048_576 {
		return errors.New("context length must be between 1 and 1048576")
	}
	if v.MaxOutputTokens < 1 || v.MaxOutputTokens > 32768 {
		return errors.New("maximum output tokens must be between 1 and 32768")
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
		"VEIL_ENV_FILE=-", "VEIL_ADDR=" + veilAddress, "VEIL_AUTH_TOKEN=" + token,
		"VEIL_PROVIDER_PROTOCOL=" + v.Protocol, "VEIL_PROVIDER_BASE_URL=" + v.ProviderBaseURL,
		"VEIL_MODEL=" + v.Model, "VEIL_MAX_OUTPUT_TOKENS=" + strconv.Itoa(v.MaxOutputTokens),
		"VEIL_MODEL_TIMEOUT=" + v.ModelTimeout.String(), "VEIL_REQUEST_TIMEOUT=" + v.RequestTimeout.String(),
		"VEIL_MAX_BODY_BYTES=" + strconv.FormatInt(v.MaxBodyBytes, 10), "VEIL_TELEMETRY_ENABLED=false",
	}
	if v.ContextLength > 0 {
		values = append(values, "VEIL_CONTEXT_LENGTH="+strconv.Itoa(v.ContextLength))
	}
	return values
}

func (v Veil) CompanyEnvironment(veilAddress, internalToken, controlToken, entitlementPath, identityStorePath string) []string {
	values := v.Environment(veilAddress, internalToken)
	values = append(values,
		"VEIL_COMPANY_IDENTITY_MODE=true",
		"VEIL_CONTROL_TOKEN="+controlToken,
		"VEIL_ENTITLEMENT_PATH="+entitlementPath,
		"VEIL_IDENTITY_STORE_PATH="+identityStorePath,
	)
	return values
}
