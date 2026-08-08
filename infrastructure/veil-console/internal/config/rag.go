package config

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Routes are the product routes a document can be tagged with. "all" is the
// catch-all every route retrieves alongside its own tag.
const RouteAll = "all"

var Routes = []string{"engineering", "sales", "marketing", RouteAll}

func ValidRoute(route string) bool {
	for _, candidate := range Routes {
		if candidate == route {
			return true
		}
	}
	return false
}

// RAG is the retrieval configuration Console owns and Veil receives through the
// supervisor's child environment. The Qdrant API key is deliberately absent: it
// is read from a restricted file at start time and never stored in console.db.
type RAG struct {
	Enabled          bool
	VectorBaseURL    string
	Collection       string
	EmbeddingBaseURL string
	EmbeddingModel   string
	// Dimension is learned by probing the embedding endpoint. It decides the
	// Qdrant vector size, so a model change means a new collection and a
	// re-embed rather than a mixed corpus.
	Dimension        int
	TopK             int
	MaxInjectedBytes int
	Timeout          time.Duration
}

func DefaultRAG() RAG {
	return RAG{
		VectorBaseURL:    "http://127.0.0.1:6333",
		Collection:       "company_docs_v1",
		EmbeddingBaseURL: "http://127.0.0.1:8001/v1",
		TopK:             6,
		MaxInjectedBytes: 12288,
		Timeout:          2 * time.Second,
	}
}

func (r RAG) Validate() error {
	if err := validateLocalURL(r.VectorBaseURL, "vector database URL"); err != nil {
		return err
	}
	if err := validateLocalURL(r.EmbeddingBaseURL, "embedding runtime URL"); err != nil {
		return err
	}
	name := strings.TrimSpace(r.Collection)
	if name == "" || len(name) > 64 || strings.ContainsAny(name, "/\\ \r\n\x00") {
		return errors.New("collection name is required and must be 64 characters or fewer")
	}
	if r.Enabled && strings.TrimSpace(r.EmbeddingModel) == "" {
		return errors.New("an embedding model is required before retrieval can be enabled")
	}
	if len(r.EmbeddingModel) > 256 || strings.ContainsAny(r.EmbeddingModel, "\r\n\x00") {
		return errors.New("embedding model is invalid")
	}
	if r.Dimension < 0 || r.Dimension > 8192 {
		return errors.New("embedding dimension is outside the supported range")
	}
	if r.Enabled && r.Dimension <= 0 {
		return errors.New("test the embedding runtime before enabling retrieval")
	}
	if r.TopK < 1 || r.TopK > 32 {
		return errors.New("results per request must be between 1 and 32")
	}
	if r.MaxInjectedBytes < 1024 || r.MaxInjectedBytes > 262144 {
		return errors.New("injected context must be between 1024 and 262144 bytes")
	}
	if r.Timeout < 100*time.Millisecond || r.Timeout > 30*time.Second {
		return errors.New("retrieval timeout is outside the supported range")
	}
	return nil
}

func validateLocalURL(value, label string) error {
	parsed, err := url.ParseRequestURI(strings.TrimSpace(value))
	if err != nil || parsed.Hostname() == "" {
		return errors.New(label + " must include a valid host")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New(label + " must use http or https")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return errors.New(label + " must not contain credentials or a fragment")
	}
	return nil
}

// Environment renders the allowlisted RAG variables for the Veil child process.
// A disabled corpus still passes the values through so a restart is not needed
// to turn retrieval back on with the same settings.
func (r RAG) Environment(apiKey string) []string {
	return []string{
		"VEIL_RAG_ENABLED=" + strconv.FormatBool(r.Enabled),
		"VEIL_RAG_VECTOR_BASE_URL=" + r.VectorBaseURL,
		"VEIL_RAG_VECTOR_API_KEY=" + apiKey,
		"VEIL_RAG_COLLECTION=" + r.Collection,
		"VEIL_RAG_EMBEDDING_BASE_URL=" + r.EmbeddingBaseURL,
		"VEIL_RAG_EMBEDDING_MODEL=" + r.EmbeddingModel,
		"VEIL_RAG_TOP_K=" + strconv.Itoa(r.TopK),
		"VEIL_RAG_MAX_INJECTED_BYTES=" + strconv.Itoa(r.MaxInjectedBytes),
		"VEIL_RAG_TIMEOUT=" + r.Timeout.String(),
	}
}
