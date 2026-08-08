package config

import (
	"errors"
	"os"
	"strings"
	"time"
)

// RAG is the company-corpus retrieval configuration. Console owns every value
// and passes them through the child environment; Veil only reads them.
//
// Retrieval is a best-effort enrichment, never a dependency: if any of this is
// wrong or unreachable at request time, the chat request still has to succeed.
// The validation here is therefore about refusing to start with a nonsense
// configuration, not about guaranteeing the services answer.
type RAG struct {
	Enabled          bool
	VectorBaseURL    string
	VectorAPIKey     string
	Collection       string
	EmbeddingBaseURL string
	EmbeddingModel   string
	TopK             int
	MaxInjectedBytes int
	Timeout          time.Duration
}

func loadRAG() (RAG, error) {
	enabled, err := envBool("VEIL_RAG_ENABLED", false)
	if err != nil {
		return RAG{}, err
	}
	topK, err := envInt("VEIL_RAG_TOP_K", 6)
	if err != nil {
		return RAG{}, err
	}
	maxInjected, err := envInt("VEIL_RAG_MAX_INJECTED_BYTES", 12288)
	if err != nil {
		return RAG{}, err
	}
	timeout, err := envDuration("VEIL_RAG_TIMEOUT", 2*time.Second)
	if err != nil {
		return RAG{}, err
	}
	cfg := RAG{
		Enabled:          enabled,
		VectorBaseURL:    strings.TrimSpace(os.Getenv("VEIL_RAG_VECTOR_BASE_URL")),
		VectorAPIKey:     strings.TrimSpace(os.Getenv("VEIL_RAG_VECTOR_API_KEY")),
		Collection:       envString("VEIL_RAG_COLLECTION", "company_docs_v1"),
		EmbeddingBaseURL: strings.TrimSpace(os.Getenv("VEIL_RAG_EMBEDDING_BASE_URL")),
		EmbeddingModel:   strings.TrimSpace(os.Getenv("VEIL_RAG_EMBEDDING_MODEL")),
		TopK:             topK,
		MaxInjectedBytes: maxInjected,
		Timeout:          timeout,
	}
	if !cfg.Enabled {
		return cfg, nil
	}
	if cfg.VectorBaseURL == "" {
		return RAG{}, errors.New("VEIL_RAG_VECTOR_BASE_URL is required when retrieval is enabled")
	}
	if cfg.EmbeddingBaseURL == "" {
		return RAG{}, errors.New("VEIL_RAG_EMBEDDING_BASE_URL is required when retrieval is enabled")
	}
	if cfg.EmbeddingModel == "" {
		return RAG{}, errors.New("VEIL_RAG_EMBEDDING_MODEL is required when retrieval is enabled")
	}
	if cfg.TopK < 1 || cfg.TopK > 32 {
		return RAG{}, errors.New("VEIL_RAG_TOP_K must be between 1 and 32")
	}
	if cfg.MaxInjectedBytes < 1024 || cfg.MaxInjectedBytes > 262144 {
		return RAG{}, errors.New("VEIL_RAG_MAX_INJECTED_BYTES must be between 1024 and 262144")
	}
	if cfg.Timeout <= 0 || cfg.Timeout > 30*time.Second {
		return RAG{}, errors.New("VEIL_RAG_TIMEOUT must be positive and at most 30s")
	}
	return cfg, nil
}
