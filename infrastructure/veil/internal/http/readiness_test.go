package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"umbratic-veil/internal/model"
)

func chatRequest(server *Server) *httptest.ResponseRecorder {
	body := `{"messages":[{"role":"user","content":"hello"}],"stream":false}`
	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)
	return rr
}

func TestDrainingRefusesNewModelWorkWithAStableCode(t *testing.T) {
	server := NewServer(testConfig(), &fakeModelClient{})
	if got := chatRequest(server).Code; got == http.StatusServiceUnavailable {
		t.Fatalf("a healthy server must accept model work, got %d", got)
	}

	server.BeginDrain()
	rr := chatRequest(server)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("draining must refuse model work, got %d", rr.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "draining" {
		t.Fatalf("expected a draining code, got %#v", body)
	}
	if rr.Header().Get("Retry-After") == "" {
		t.Fatal("a refusal must tell the caller when to retry")
	}
}

func TestHealthReportsReadinessSeparatelyFromLiveness(t *testing.T) {
	server := NewServer(testConfig(), &fakeModelClient{})
	state := func() string {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set("Authorization", "Bearer test-token")
		rr := httptest.NewRecorder()
		server.ServeHTTP(rr, req)
		var body map[string]any
		_ = json.NewDecoder(rr.Body).Decode(&body)
		return body["state"].(string)
	}
	// A successful health check is the warm signal.
	if got := state(); got != string(lifecycleReady) {
		t.Fatalf("expected ready after a successful health check, got %q", got)
	}
	server.BeginDrain()
	if got := state(); got != string(lifecycleDraining) {
		t.Fatalf("expected draining, got %q", got)
	}
}

// flakyModelClient fails the first DoChat and succeeds afterwards.
type flakyModelClient struct {
	fakeModelClient
	attempts int
	failWith int
}

func (f *flakyModelClient) DoChat(ctx context.Context, req model.ChatRequest) (*http.Response, error) {
	f.attempts++
	if f.attempts == 1 {
		return &http.Response{
			StatusCode: f.failWith,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(bytes.NewBufferString(`{"error":"upstream restarting"}`)),
		}, nil
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(bytes.NewBufferString("data: [DONE]\n\n")),
	}, nil
}

func TestAnUncommittedStreamIsRetriedExactlyOnce(t *testing.T) {
	client := &flakyModelClient{failWith: http.StatusServiceUnavailable}
	server := NewServer(testConfig(), client)
	body := `{"messages":[{"role":"user","content":"hello"}],"stream":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("a pre-commit retry should have recovered the stream, got %d %s", rr.Code, rr.Body.String())
	}
	if client.attempts != 2 {
		t.Fatalf("expected exactly one retry, got %d attempts", client.attempts)
	}
}

func TestACommittedStreamIsNeverRetried(t *testing.T) {
	// A status the runtime will answer the same way twice is not retried, so a
	// bad request cannot be doubled into extra load.
	client := &flakyModelClient{failWith: http.StatusBadRequest}
	server := NewServer(testConfig(), client)
	body := `{"messages":[{"role":"user","content":"hello"}],"stream":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if client.attempts != 1 {
		t.Fatalf("a non-retryable status must not be repeated, got %d attempts", client.attempts)
	}
	if rr.Code == http.StatusOK {
		t.Fatalf("expected the upstream failure to surface, got %d", rr.Code)
	}
}
