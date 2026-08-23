package config

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Routes are the teams a document can be made available to.
//
// There is no "all" any more. It was a fourth route that meant "the other
// three", which made a document either targeted or shared but never, say, both
// engineering and sales — and it put a catch-all in the same menu as the things
// it was a catch-all for. A document now carries a set of routes, and
// everything that used to be "all" is all three of them checked.
var Routes = []string{"engineering", "sales", "marketing"}

func ValidRoute(route string) bool {
	for _, candidate := range Routes {
		if candidate == route {
			return true
		}
	}
	return false
}

// ParseRoutes reads the stored form — one comma-separated field, canonically
// ordered — into a set. Unknown and duplicate entries are dropped rather than
// carried: this value decides who can retrieve a document, so anything not
// recognized is not a route.
func ParseRoutes(stored string) []string {
	seen := make(map[string]bool, len(Routes))
	for _, part := range strings.Split(stored, ",") {
		part = strings.ToLower(strings.TrimSpace(part))
		// "all" is how the fourth route was spelled before it was removed.
		if part == "all" {
			return append([]string(nil), Routes...)
		}
		if ValidRoute(part) {
			seen[part] = true
		}
	}
	return canonicalRoutes(seen)
}

// NormalizeRoutes canonicalizes a set arriving from a form.
func NormalizeRoutes(routes []string) []string {
	seen := make(map[string]bool, len(routes))
	for _, route := range routes {
		route = strings.ToLower(strings.TrimSpace(route))
		if ValidRoute(route) {
			seen[route] = true
		}
	}
	return canonicalRoutes(seen)
}

// canonicalRoutes returns the set in catalog order, so the stored string for a
// given set is always the same string.
func canonicalRoutes(seen map[string]bool) []string {
	routes := make([]string, 0, len(seen))
	for _, route := range Routes {
		if seen[route] {
			routes = append(routes, route)
		}
	}
	return routes
}

// FormatRoutes is the stored form.
func FormatRoutes(routes []string) string {
	return strings.Join(NormalizeRoutes(routes), ",")
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

// The retrieval settings Console no longer asks for.
//
// Every one of these was a field on the Documents page, and every one of them
// had exactly one answer worth giving: the loopback runtime Console starts, the
// collection it owns, and the industry-standard retrieval window. An
// administrator setting up a company deployment does not have a better number
// for `top_k` than 6, and asking them for it made a page about documents look
// like a database console. They are constants now. Changing one is a code
// change, which is the honest weight for a decision nobody was making.
const (
	DefaultVectorBaseURL    = "http://127.0.0.1:6333"
	DefaultCollection       = "company_docs_v1"
	DefaultEmbeddingBaseURL = "http://127.0.0.1:8001/v1"
	DefaultTopK             = 6
	DefaultMaxInjectedBytes = 12288
	DefaultRAGTimeout       = 2 * time.Second
)

// EmbeddingChoice is one embedding model the Documents page offers.
//
// Dimension is recorded rather than only probed. Probing is still what
// confirms a runtime is actually serving the model, but knowing the width up
// front is what lets retrieval be on out of the box: the Qdrant collection can
// be created before anything has been embedded, instead of making someone press
// "Test runtime" before the checkbox would even validate.
type EmbeddingChoice struct {
	Model     string
	Label     string
	Dimension int
	Detail    string
	// SizeGB is what the weights occupy, so the menu can say what choosing this
	// costs on a card that is already holding a chat model.
	SizeGB float64
}

// EmbeddingChoices is the closed list, the default first. Both are 1024-wide,
// so switching between them does not strand the collection at another size.
var EmbeddingChoices = []EmbeddingChoice{
	{
		Model:     "Qwen/Qwen3-Embedding-0.6B",
		Label:     "Qwen3 Embedding 0.6B",
		Dimension: 1024,
		SizeGB:    1.2,
		Detail:    "Strong multilingual retrieval, small enough to share a card with the chat model.",
	},
	{
		Model:     "BAAI/bge-m3",
		Label:     "BGE-M3",
		Dimension: 1024,
		SizeGB:    2.3,
		Detail:    "Better on long, dense technical documents. Twice the weights.",
	},
}

// EmbeddingDimension is the width a chosen model embeds at, or zero for one
// this list does not name.
func EmbeddingDimension(model string) int {
	for _, choice := range EmbeddingChoices {
		if strings.EqualFold(choice.Model, model) {
			return choice.Dimension
		}
	}
	return 0
}

// DefaultRAG is retrieval on, with the default embedding model already chosen.
// Off-by-default made the Documents page open on a banner telling the
// administrator to go configure something before it would do anything, which is
// a setup step disguised as a warning.
func DefaultRAG() RAG {
	choice := EmbeddingChoices[0]
	return RAG{
		Enabled:          true,
		VectorBaseURL:    DefaultVectorBaseURL,
		Collection:       DefaultCollection,
		EmbeddingBaseURL: DefaultEmbeddingBaseURL,
		EmbeddingModel:   choice.Model,
		Dimension:        choice.Dimension,
		TopK:             DefaultTopK,
		MaxInjectedBytes: DefaultMaxInjectedBytes,
		Timeout:          DefaultRAGTimeout,
	}
}

// WithDefaults fills the constants back in over whatever is stored, so a
// configuration written before they were constants still serves the values this
// build means. Only the two things the page still asks for survive from the
// stored row: whether retrieval is on, and which embedding model it uses.
func (r RAG) WithDefaults() RAG {
	defaults := DefaultRAG()
	defaults.Enabled = r.Enabled
	if strings.TrimSpace(r.EmbeddingModel) != "" {
		defaults.EmbeddingModel = r.EmbeddingModel
		defaults.Dimension = r.Dimension
		if width := EmbeddingDimension(r.EmbeddingModel); width > 0 {
			defaults.Dimension = width
		}
	}
	return defaults
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

// EmbeddingLabel is the human name of the chosen embedding model, for the
// menu's closed state. An unrecognized model — one stored before this list was
// closed — shows its own reference rather than nothing.
func (r RAG) EmbeddingLabel() string {
	for _, choice := range EmbeddingChoices {
		if strings.EqualFold(choice.Model, r.EmbeddingModel) {
			return choice.Label
		}
	}
	return r.EmbeddingModel
}
