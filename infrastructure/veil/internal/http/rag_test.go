package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"umbratic-veil/internal/config"
	"umbratic-veil/internal/model"
)

func ragTestConfig(vectorURL string) config.Config {
	cfg := testConfig()
	cfg.RAG = config.RAG{
		Enabled: true, VectorBaseURL: vectorURL, VectorAPIKey: "k",
		Collection: "company_docs_v1", EmbeddingBaseURL: "http://127.0.0.1:8001/v1",
		EmbeddingModel: "test-embed", TopK: 6, MaxInjectedBytes: 12288, Timeout: 2 * time.Second,
	}
	return cfg
}

func vectorStub(t *testing.T, text string) (*httptest.Server, *string) {
	t.Helper()
	var route string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var body struct {
			Filter struct {
				Must []struct {
					Key   string `json:"key"`
					Match struct {
						Any []string `json:"any"`
					} `json:"match"`
				} `json:"must"`
			} `json:"filter"`
		}
		_ = json.Unmarshal(payload, &body)
		for _, clause := range body.Filter.Must {
			if clause.Key == "route" {
				route = strings.Join(clause.Match.Any, ",")
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"points": []map[string]any{
			{"score": 0.9, "payload": map[string]any{
				"doc_name": "Handbook.md", "section": "Refunds", "text": text,
			}},
		}}})
	}))
	t.Cleanup(server.Close)
	return server, &route
}

func chatRequestTo(server *Server, path, message string) *httptest.ResponseRecorder {
	body := `{"messages":[{"role":"user","content":` + jsonString(message) + `}],"stream":false}`
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	return recorder
}

func jsonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

// The retrieved text has to reach the model as request-scoped untrusted
// context, in the same block as any other overlay, with its citation attached.
func TestChatInjectsRetrievedContextUnderOneBanner(t *testing.T) {
	vector, route := vectorStub(t, "Refunds are processed within 14 days.")
	client := &fakeModelClient{}
	server := NewServer(ragTestConfig(vector.URL), client)

	if code := chatRequestTo(server, "/api/sales/chat", "how long do refunds take?").Code; code != http.StatusOK {
		t.Fatalf("chat failed: %d", code)
	}
	if *route != "sales" {
		t.Fatalf("retrieval asked for the wrong routes: %q", *route)
	}
	final := lastUserContent(t, client.req.Messages)
	if strings.Count(final, "Request-scoped server metadata") != 1 {
		t.Fatalf("expected exactly one untrusted-context banner: %q", final)
	}
	if !strings.Contains(final, "[Handbook.md — Refunds]") || !strings.Contains(final, "processed within 14 days") {
		t.Fatalf("retrieved context did not reach the model: %q", final)
	}
	if client.embedCalls != 1 {
		t.Fatalf("expected one embedding call, got %d", client.embedCalls)
	}
	if client.embedQuery != "how long do refunds take?" {
		t.Fatalf("the wrong text was embedded: %q", client.embedQuery)
	}
}

func TestEngineeringAndSalesRetrieveTheirOwnRoutes(t *testing.T) {
	// Each route asks for itself and nothing else. A document meant for more
	// than one team carries each of them in its payload, so the widening
	// happens in the corpus rather than in the query.
	for path, want := range map[string]string{
		"/api/engineering/chat": "engineering",
		"/api/marketing/chat":   "marketing",
		"/api/sales/chat":       "sales",
	} {
		vector, route := vectorStub(t, "text")
		server := NewServer(ragTestConfig(vector.URL), &fakeModelClient{})
		chatRequestTo(server, path, "question")
		if *route != want {
			t.Errorf("%s retrieved %q, want %q", path, *route, want)
		}
	}
}

// Retrieval is an enrichment. When it cannot run, the chat request still has to
// succeed and the message must be exactly what it would have been.
func TestChatSucceedsWhenRetrievalIsUnavailable(t *testing.T) {
	cfg := ragTestConfig("http://127.0.0.1:1")
	client := &fakeModelClient{}
	server := NewServer(cfg, client)
	if code := chatRequestTo(server, "/api/sales/chat", "question").Code; code != http.StatusOK {
		t.Fatalf("an unreachable vector database broke chat: %d", code)
	}
	if content := lastUserContent(t, client.req.Messages); strings.Contains(content, "Request-scoped server metadata") {
		t.Fatalf("a failed retrieval still injected: %q", content)
	}

	metrics := httptest.NewRequest(http.MethodGet, "/api/runtime/metrics", nil)
	metrics.Header.Set("Authorization", "Bearer test-token")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, metrics)
	var body map[string]any
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["rag_skipped_unavailable"] != float64(1) {
		t.Fatalf("the skip was not counted: %v", body["rag_skipped_unavailable"])
	}
}

// A feature name is a promise. A server with retrieval switched off must not
// make it, and a client that gates on the name then does nothing.
func TestHealthAdvertisesRAGOnlyWhenEnabled(t *testing.T) {
	features := func(cfg config.Config) []string {
		server := NewServer(cfg, &fakeModelClient{models: []model.ModelInfo{{ID: "default-model"}}})
		request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		request.Header.Set("Authorization", "Bearer test-token")
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, request)
		var body struct {
			Features []string `json:"features"`
		}
		if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body.Features
	}
	if slices.Contains(features(testConfig()), "rag") {
		t.Fatal("a server without retrieval advertised rag")
	}
	if !slices.Contains(features(ragTestConfig("http://127.0.0.1:6333")), "rag") {
		t.Fatal("a server with retrieval did not advertise rag")
	}
}

func lastUserContent(t *testing.T, messages []model.Message) string {
	t.Helper()
	for index := len(messages) - 1; index >= 0; index-- {
		if messages[index].Role != "user" {
			continue
		}
		content, ok := messages[index].Content.(string)
		if !ok {
			t.Fatalf("last user message is not text: %#v", messages[index].Content)
		}
		return content
	}
	t.Fatal("no user message reached the model")
	return ""
}
