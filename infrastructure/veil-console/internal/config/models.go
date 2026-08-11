package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// ManagedModel is one vLLM process Console launches and supervises.
//
// Every field is typed and bounded, and the argv the supervisor builds is
// assembled from these fields alone. Console has no shell and no free-form
// argument field, and this struct is why: a launcher that accepts arbitrary
// arguments is a command runner, which the security boundary forbids.
type ManagedModel struct {
	// ID is the served model name — what a client sends as `model` and what
	// `/v1/models` reports back.
	ID          string
	DisplayName string
	// ModelPath is a Hugging Face repository id or an absolute path on this
	// machine. It is passed as vLLM's positional model argument.
	ModelPath            string
	Port                 int
	MaxModelLen          int
	GPUMemoryUtilization float64
	// KVCacheDType is the KV cache precision. fp8 is vLLM's 8-bit option and
	// the default here; there is no literal "q8" in vLLM.
	KVCacheDType string
	// Reasoning declares that this model emits thinking. Veil publishes it as
	// `capabilities.reasoning`, which is what gates the desktop's Think toggle.
	Reasoning bool
}

const (
	KVCacheFP8  = "fp8"
	KVCacheAuto = "auto"
	// MinManagedPort and MaxManagedPort bound the loopback ports Console will
	// bind a runtime to. Below 1024 is privileged; the range is deliberately
	// small so a typo cannot land on an unrelated service.
	MinManagedPort = 1024
	MaxManagedPort = 65535
	// SuggestedPortStart is where the Add form's port suggestion begins.
	SuggestedPortStart = 8001
	SuggestedPortEnd   = 8099
	MinMaxModelLen     = 1024
	MaxMaxModelLen     = 1_048_576
	maxModelPathBytes  = 512
	maxDisplayBytes    = 120
)

// A served id travels in URLs, in argv, and in a JSON environment variable. The
// leading-character rule matters most: an id starting with `-` would be read by
// vLLM as a flag rather than a value.
var managedModelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func (m ManagedModel) Validate() error {
	if !managedModelID.MatchString(m.ID) {
		return errors.New("served id must start with a letter or digit and use only letters, digits, dots, dashes, or underscores")
	}
	display := strings.TrimSpace(m.DisplayName)
	if display == "" || len(display) > maxDisplayBytes {
		return fmt.Errorf("display name is required and must be %d characters or fewer", maxDisplayBytes)
	}
	if strings.ContainsAny(display, "\r\n\x00") {
		return errors.New("display name must not contain control characters")
	}
	path := strings.TrimSpace(m.ModelPath)
	if path == "" || len(path) > maxModelPathBytes {
		return fmt.Errorf("model must be between 1 and %d characters", maxModelPathBytes)
	}
	if strings.HasPrefix(path, "-") {
		return errors.New("model must not start with a dash")
	}
	for _, character := range path {
		if character < 0x20 || character == 0x7f {
			return errors.New("model must not contain control characters")
		}
	}
	if m.Port < MinManagedPort || m.Port > MaxManagedPort {
		return fmt.Errorf("port must be between %d and %d", MinManagedPort, MaxManagedPort)
	}
	if m.MaxModelLen < MinMaxModelLen || m.MaxModelLen > MaxMaxModelLen {
		return fmt.Errorf("max model length must be between %d and %d", MinMaxModelLen, MaxMaxModelLen)
	}
	if m.GPUMemoryUtilization <= 0 || m.GPUMemoryUtilization > 1 {
		return errors.New("GPU memory fraction must be greater than 0.0 and at most 1.0")
	}
	if m.KVCacheDType != KVCacheFP8 && m.KVCacheDType != KVCacheAuto {
		return errors.New("KV cache dtype must be fp8 or auto")
	}
	return nil
}

// ValidateManagedModels checks one model against the rest of the fleet and
// against the two ports Console already owns. A duplicate id or a shared port
// is a configuration that cannot start, so it is refused at the form.
func ValidateManagedModels(models []ManagedModel, consolePort, veilPort int) error {
	seenID := map[string]bool{}
	seenPort := map[int]bool{}
	for _, model := range models {
		if err := model.Validate(); err != nil {
			return fmt.Errorf("model %q: %w", model.ID, err)
		}
		if seenID[model.ID] {
			return fmt.Errorf("model id %q is already registered", model.ID)
		}
		seenID[model.ID] = true
		if seenPort[model.Port] {
			return fmt.Errorf("port %d is already used by another model", model.Port)
		}
		seenPort[model.Port] = true
		if model.Port == consolePort || model.Port == veilPort {
			return fmt.Errorf("port %d is already used by Console or Veil", model.Port)
		}
	}
	return nil
}

// ProviderBaseURL is the address Veil reaches this model on. Always loopback:
// Console supervises the process on this machine, and Veil's own dialer refuses
// anything that is not loopback or private.
func (m ManagedModel) ProviderBaseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/v1", m.Port)
}

// TotalGPUFraction is the sum an administrator is warned about past 1.0. It is
// a warning rather than a limit because a multi-GPU box legitimately exceeds
// it — the fractions are per device, not per machine.
func TotalGPUFraction(models []ManagedModel) float64 {
	total := 0.0
	for _, model := range models {
		total += model.GPUMemoryUtilization
	}
	return total
}

// modelEnvEntry is the exact shape Veil's VEIL_MODELS parser accepts. It is
// declared here rather than shared through a package because Console and Veil
// are released separately: the contract is the JSON, not a Go type.
type modelEnvEntry struct {
	ID              string `json:"id"`
	ProviderBaseURL string `json:"provider_base_url"`
	Display         string `json:"display"`
	Reasoning       bool   `json:"reasoning"`
	ContextLength   int    `json:"context_length"`
}

// ModelsEnvJSON renders VEIL_MODELS. Empty when there are no managed models, so
// Veil keeps its single-model behavior and never advertises model selection.
func ModelsEnvJSON(models []ManagedModel) (string, error) {
	if len(models) == 0 {
		return "", nil
	}
	entries := make([]modelEnvEntry, 0, len(models))
	for _, model := range models {
		entries = append(entries, modelEnvEntry{
			ID:              model.ID,
			ProviderBaseURL: model.ProviderBaseURL(),
			Display:         strings.TrimSpace(model.DisplayName),
			Reasoning:       model.Reasoning,
			ContextLength:   model.MaxModelLen,
		})
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
