package rag

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"umbratic-veil/internal/config"
)

type stubEmbedder struct {
	vector []float32
	err    error
	calls  int
	last   string
}

func (s *stubEmbedder) Embed(_ context.Context, text string) ([]float32, error) {
	s.calls++
	s.last = text
	if s.err != nil {
		return nil, s.err
	}
	if s.vector == nil {
		return []float32{0.5, 0.25}, nil
	}
	return s.vector, nil
}

// qdrantStub records the search body and answers with the given points.
type qdrantStub struct {
	server   *httptest.Server
	lastBody map[string]any
	status   int
	points   []map[string]any
	apiKey   string
}

func newQdrantStub(t *testing.T, points []map[string]any) *qdrantStub {
	t.Helper()
	stub := &qdrantStub{points: points, status: http.StatusOK}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stub.apiKey = r.Header.Get("api-key")
		payload, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		_ = json.Unmarshal(payload, &stub.lastBody)
		if stub.status != http.StatusOK {
			w.WriteHeader(stub.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"points": stub.points}})
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func testConfig(baseURL string) config.RAG {
	return config.RAG{
		Enabled: true, VectorBaseURL: baseURL, VectorAPIKey: "test-key",
		Collection: "company_docs_v1", EmbeddingBaseURL: "http://127.0.0.1:8001/v1",
		EmbeddingModel: "test-embed", TopK: 6, MaxInjectedBytes: 12288, Timeout: 2 * time.Second,
	}
}

func point(name, section, text string) map[string]any {
	return map[string]any{"score": 0.9, "payload": map[string]any{
		"doc_name": name, "section": section, "text": text,
		"route": "sales", "embedding_model": "test-embed",
	}}
}

// The route split is the whole tenancy guarantee: a sales request must ask for
// sales and all, and for nothing else.
func TestOverlayFiltersByRouteAndModel(t *testing.T) {
	stub := newQdrantStub(t, []map[string]any{point("Pricing.md", "Discounts", "Volume discounts start at 50 seats.")})
	retriever := New(testConfig(stub.server.URL), &stubEmbedder{})
	overlay := retriever.Overlay(context.Background(), "sales", "what are the volume discounts?")

	if !strings.Contains(overlay, "Pricing.md — Discounts") {
		t.Fatalf("overlay is missing the citation: %q", overlay)
	}
	if !strings.Contains(overlay, "Volume discounts start at 50 seats.") {
		t.Fatalf("overlay is missing the chunk text: %q", overlay)
	}
	if stub.apiKey != "test-key" {
		t.Fatalf("the vector database was called without its API key: %q", stub.apiKey)
	}
	encoded, _ := json.Marshal(stub.lastBody["filter"])
	filter := string(encoded)
	for _, want := range []string{`"route"`, `"sales"`, `"all"`, `"embedding_model"`, `"test-embed"`} {
		if !strings.Contains(filter, want) {
			t.Fatalf("filter %s is missing %s", filter, want)
		}
	}
	if strings.Contains(filter, "engineering") || strings.Contains(filter, "marketing") {
		t.Fatalf("filter reached another route: %s", filter)
	}
	if counters := retriever.Counters(); counters["rag_injected"] != 1 {
		t.Fatalf("injection was not counted: %v", counters)
	}
}

// Every failure mode below must leave the request exactly as it would be
// without retrieval, and say so in a counter rather than in the response.
func TestOverlayDegradesGracefully(t *testing.T) {
	t.Run("vector database down", func(t *testing.T) {
		stub := newQdrantStub(t, nil)
		stub.status = http.StatusServiceUnavailable
		retriever := New(testConfig(stub.server.URL), &stubEmbedder{})
		if overlay := retriever.Overlay(context.Background(), "sales", "anything"); overlay != "" {
			t.Fatalf("overlay was injected despite an unavailable vector database: %q", overlay)
		}
		if counters := retriever.Counters(); counters["rag_skipped_unavailable"] != 1 {
			t.Fatalf("skip was not counted: %v", counters)
		}
	})

	t.Run("embedding runtime down", func(t *testing.T) {
		stub := newQdrantStub(t, []map[string]any{point("A.md", "", "text")})
		retriever := New(testConfig(stub.server.URL), &stubEmbedder{err: errors.New("connection refused")})
		if overlay := retriever.Overlay(context.Background(), "sales", "anything"); overlay != "" {
			t.Fatalf("overlay was injected without an embedding: %q", overlay)
		}
		if counters := retriever.Counters(); counters["rag_skipped_unavailable"] != 1 {
			t.Fatalf("skip was not counted: %v", counters)
		}
	})

	t.Run("no matching chunks", func(t *testing.T) {
		stub := newQdrantStub(t, []map[string]any{})
		retriever := New(testConfig(stub.server.URL), &stubEmbedder{})
		if overlay := retriever.Overlay(context.Background(), "sales", "anything"); overlay != "" {
			t.Fatalf("an empty result produced an overlay: %q", overlay)
		}
		if counters := retriever.Counters(); counters["rag_empty_results"] != 1 {
			t.Fatalf("empty result was not counted: %v", counters)
		}
	})

	t.Run("disabled", func(t *testing.T) {
		cfg := testConfig("http://127.0.0.1:6333")
		cfg.Enabled = false
		embedder := &stubEmbedder{}
		retriever := New(cfg, embedder)
		if overlay := retriever.Overlay(context.Background(), "sales", "anything"); overlay != "" {
			t.Fatalf("a disabled retriever injected: %q", overlay)
		}
		if embedder.calls != 0 {
			t.Fatal("a disabled retriever still called the embedding runtime")
		}
		if counters := retriever.Counters(); counters["rag_injected"] != 0 {
			t.Fatalf("a disabled retriever reported activity: %v", counters)
		}
	})

	t.Run("empty query", func(t *testing.T) {
		stub := newQdrantStub(t, []map[string]any{point("A.md", "", "text")})
		embedder := &stubEmbedder{}
		retriever := New(testConfig(stub.server.URL), embedder)
		if overlay := retriever.Overlay(context.Background(), "sales", "   "); overlay != "" {
			t.Fatalf("an empty query produced an overlay: %q", overlay)
		}
		if embedder.calls != 0 {
			t.Fatal("an empty query still called the embedding runtime")
		}
	})
}

func TestOverlayStopsAtTheByteBudget(t *testing.T) {
	long := strings.Repeat("x", 900)
	stub := newQdrantStub(t, []map[string]any{
		point("A.md", "one", long), point("B.md", "two", long), point("C.md", "three", long),
	})
	cfg := testConfig(stub.server.URL)
	cfg.MaxInjectedBytes = 2000
	overlay := New(cfg, &stubEmbedder{}).Overlay(context.Background(), "sales", "question")
	if len(overlay) > cfg.MaxInjectedBytes {
		t.Fatalf("overlay of %d bytes exceeded the %d byte budget", len(overlay), cfg.MaxInjectedBytes)
	}
	if !strings.Contains(overlay, "A.md") || strings.Contains(overlay, "C.md") {
		t.Fatalf("budget was not applied in score order: %q", overlay[:min(len(overlay), 200)])
	}
}

// Payload text is data Console wrote, but it still reaches a prompt, so it is
// read as untrusted: control characters out, lengths bounded.
func TestPayloadTextIsSanitizedAndBounded(t *testing.T) {
	stub := newQdrantStub(t, []map[string]any{
		point("doc\x00name.md", strings.Repeat("s", 400), "clean\x07 text"),
	})
	overlay := New(testConfig(stub.server.URL), &stubEmbedder{}).Overlay(context.Background(), "sales", "question")
	if strings.ContainsAny(overlay, "\x00\x07") {
		t.Fatalf("control characters reached the overlay: %q", overlay)
	}
	if strings.Contains(overlay, strings.Repeat("s", 200)) && len(overlay) > 12288 {
		t.Fatal("locator was not bounded")
	}
}

func TestQueryIsBoundedBeforeEmbedding(t *testing.T) {
	stub := newQdrantStub(t, []map[string]any{point("A.md", "", "text")})
	embedder := &stubEmbedder{}
	New(testConfig(stub.server.URL), embedder).Overlay(context.Background(), "sales", strings.Repeat("q", 10_000))
	if len(embedder.last) > maxQueryBytes {
		t.Fatalf("query of %d bytes was sent unbounded", len(embedder.last))
	}
}
