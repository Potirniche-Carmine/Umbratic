package model

import (
	"fmt"
	"strings"
	"time"
)

// Mode selects the trusted provider adapter once at Veil startup.
//
// Both adapters speak OpenAI: Server is a vLLM fleet on company infrastructure,
// Local is the llama-server the desktop starts on loopback and holds a
// per-run bearer for. The mode no longer decides which routes exist — it
// decides the handful of places the two runtimes genuinely differ: the
// /tokenize request shape, whether a per-request response schema is Veil's to
// impose, where the context length is authoritative, and whether the local
// tool-call healer runs.
type Mode string

const (
	ModeServer Mode = "server"
	ModeLocal  Mode = "local"
)

func ParseMode(value string) (Mode, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "server":
		return ModeServer, nil
	case "local":
		return ModeLocal, nil
	default:
		return "", fmt.Errorf("unsupported Veil mode %q; expected server or local", value)
	}
}

type ReasoningEffort string

const (
	// ReasoningNone says nothing about thinking: the model is left on whatever
	// its chat template does by default. ReasoningOff is the opposite kind of
	// statement — it turns thinking off, which for a template that thinks by
	// default is a decision somebody made rather than one nobody made.
	// ReasoningOn turns it on without grading it, for the templates that read
	// enable_thinking and nothing finer.
	ReasoningNone   ReasoningEffort = "none"
	ReasoningOff    ReasoningEffort = "off"
	ReasoningOn     ReasoningEffort = "on"
	ReasoningLow    ReasoningEffort = "low"
	ReasoningMedium ReasoningEffort = "medium"
	ReasoningHigh   ReasoningEffort = "high"
)

func ParseReasoningEffort(value string) (ReasoningEffort, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "none":
		return ReasoningNone, nil
	case "off":
		return ReasoningOff, nil
	case "on":
		return ReasoningOn, nil
	case "low":
		return ReasoningLow, nil
	case "medium":
		return ReasoningMedium, nil
	case "high":
		return ReasoningHigh, nil
	default:
		return "", fmt.Errorf("unsupported reasoning effort %q", value)
	}
}

// GenerationProfile is the server-owned sampling and admission profile.
type GenerationProfile struct {
	Temperature float64
	TopP        float64
	// The truncation and penalty samplers, as a model card recommends them.
	// Zero means "leave it alone" in every case, which costs nothing: a
	// recommendation of zero min-p or zero presence penalty is the runtime's
	// own default, so an omitted field and a zero one generate identically.
	TopK                      int
	MinP                      float64
	PresencePenalty           float64
	RepetitionPenalty         float64
	MaxOutputTokens           int
	ReasoningEffort           ReasoningEffort
	ThinkingTokenBudget       *int
	ParallelToolCalls         bool
	MaxConcurrentRequests     int
	MaxConcurrentRequestsUser int
	QueueTimeout              time.Duration
}

// LocalGenerationProfile is the baseline profile used in local mode. One
// llama-server on one desktop serves one person, so the concurrency numbers
// only need to cover a chat and its background work overlapping.
//
// The sampling here is a fallback, not a policy: the desktop overrides it per
// model from the catalog, which records what each model card recommends. A
// model that recommends nothing runs on these.
func LocalGenerationProfile(maxOutputTokens int) GenerationProfile {
	return GenerationProfile{
		Temperature:               0.2,
		TopP:                      0.95,
		MaxOutputTokens:           maxOutputTokens,
		ReasoningEffort:           ReasoningNone,
		ThinkingTokenBudget:       nil,
		ParallelToolCalls:         true,
		MaxConcurrentRequests:     4,
		MaxConcurrentRequestsUser: 2,
		QueueTimeout:              30 * time.Second,
	}
}

func (p GenerationProfile) Validate() error {
	if p.Temperature < 0 || p.Temperature > 2 {
		return fmt.Errorf("temperature must be between 0.0 and 2.0")
	}
	if p.TopP <= 0 || p.TopP > 1 {
		return fmt.Errorf("top_p must be greater than 0.0 and at most 1.0")
	}
	if p.TopK < 0 {
		return fmt.Errorf("top_k must not be negative")
	}
	if p.MinP < 0 || p.MinP > 1 {
		return fmt.Errorf("min_p must be between 0.0 and 1.0")
	}
	if p.PresencePenalty < -2 || p.PresencePenalty > 2 {
		return fmt.Errorf("presence penalty must be between -2.0 and 2.0")
	}
	if p.RepetitionPenalty < 0 || p.RepetitionPenalty > 2 {
		return fmt.Errorf("repetition penalty must be between 0.0 and 2.0")
	}
	if p.MaxOutputTokens < 1 || p.MaxOutputTokens > 32*1024 {
		return fmt.Errorf("max output tokens must be between 1 and 32768")
	}
	switch p.ReasoningEffort {
	case ReasoningNone, ReasoningOff, ReasoningOn, ReasoningLow, ReasoningMedium, ReasoningHigh:
	default:
		return fmt.Errorf("unsupported reasoning effort %q", p.ReasoningEffort)
	}
	if p.ThinkingTokenBudget != nil {
		if *p.ThinkingTokenBudget < 0 {
			return fmt.Errorf("thinking token budget must be non-negative")
		}
		if *p.ThinkingTokenBudget > p.MaxOutputTokens {
			return fmt.Errorf("thinking token budget must not exceed max output tokens")
		}
	}
	if p.MaxConcurrentRequests < 1 {
		return fmt.Errorf("max concurrent requests must be at least 1")
	}
	if p.MaxConcurrentRequestsUser < 1 {
		return fmt.Errorf("max concurrent requests per user must be at least 1")
	}
	if p.MaxConcurrentRequestsUser > p.MaxConcurrentRequests {
		return fmt.Errorf("max concurrent requests per user must not exceed max concurrent requests")
	}
	if p.QueueTimeout < time.Second {
		return fmt.Errorf("queue timeout must be at least 1s")
	}
	return nil
}
