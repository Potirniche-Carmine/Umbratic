package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"umbratic-veil/internal/model"
)

type Config struct {
	Addr                       string
	AuthToken                  string
	ProviderProtocol           model.ProviderProtocol
	ProviderBaseURL            string
	ProviderChatEndpointPath   string
	ProviderModelsEndpointPath string
	ProviderAPIKey             string
	DefaultModel               string
	ContextLength              int
	TemplateRegistryPath       string
	TelemetryEnabled           bool
	TelemetryStorePath         string
	TelemetryRetentionDays     int
	ModelTimeout               time.Duration
	RequestTimeout             time.Duration
	MaxBodyBytes               int64
}

func Load() (Config, error) {
	if err := loadDotEnv(envString("VEIL_ENV_FILE", ".env")); err != nil {
		return Config{}, err
	}

	modelTimeout, err := envDuration("VEIL_MODEL_TIMEOUT", 60*time.Second)
	if err != nil {
		return Config{}, err
	}
	requestTimeout, err := envDuration("VEIL_REQUEST_TIMEOUT", 75*time.Second)
	if err != nil {
		return Config{}, err
	}
	maxBodyBytes, err := envInt64("VEIL_MAX_BODY_BYTES", 1<<20)
	if err != nil {
		return Config{}, err
	}
	contextLength, err := envInt("VEIL_CONTEXT_LENGTH", 0)
	if err != nil {
		return Config{}, err
	}
	telemetryEnabled, err := envBool("VEIL_TELEMETRY_ENABLED", true)
	if err != nil {
		return Config{}, err
	}
	telemetryRetentionDays, err := envInt("VEIL_TELEMETRY_RETENTION_DAYS", 30)
	if err != nil {
		return Config{}, err
	}
	protocol, err := model.ParseProviderProtocol(os.Getenv("VEIL_PROVIDER_PROTOCOL"))
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		Addr:                       envString("VEIL_ADDR", "127.0.0.1:8080"),
		AuthToken:                  strings.TrimSpace(os.Getenv("VEIL_AUTH_TOKEN")),
		ProviderProtocol:           protocol,
		ProviderBaseURL:            strings.TrimSpace(os.Getenv("VEIL_PROVIDER_BASE_URL")),
		ProviderChatEndpointPath:   envFirst("VEIL_PROVIDER_CHAT_PATH", "VEIL_PROVIDER_ENDPOINT_PATH"),
		ProviderModelsEndpointPath: envFirst("VEIL_PROVIDER_MODELS_PATH", "VEIL_PROVIDER_MODELS_ENDPOINT_PATH"),
		ProviderAPIKey:             os.Getenv("VEIL_PROVIDER_API_KEY"),
		DefaultModel:               strings.TrimSpace(os.Getenv("VEIL_MODEL")),
		ContextLength:              contextLength,
		TemplateRegistryPath:       strings.TrimSpace(os.Getenv("VEIL_TEMPLATE_REGISTRY_PATH")),
		TelemetryEnabled:           telemetryEnabled,
		TelemetryStorePath:         strings.TrimSpace(os.Getenv("VEIL_TELEMETRY_STORE_PATH")),
		TelemetryRetentionDays:     telemetryRetentionDays,
		ModelTimeout:               modelTimeout,
		RequestTimeout:             requestTimeout,
		MaxBodyBytes:               maxBodyBytes,
	}

	if cfg.AuthToken == "" {
		return Config{}, errors.New("VEIL_AUTH_TOKEN is required")
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
	if cfg.MaxBodyBytes <= 0 {
		return Config{}, errors.New("VEIL_MAX_BODY_BYTES must be positive")
	}
	if cfg.ContextLength < 0 {
		return Config{}, errors.New("VEIL_CONTEXT_LENGTH must be positive when set")
	}
	if cfg.TelemetryRetentionDays <= 0 {
		return Config{}, errors.New("VEIL_TELEMETRY_RETENTION_DAYS must be positive")
	}

	return cfg, nil
}

func envString(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func envFirst(names ...string) string {
	for _, name := range names {
		value := strings.TrimSpace(os.Getenv(name))
		if value != "" {
			return value
		}
	}
	return ""
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
