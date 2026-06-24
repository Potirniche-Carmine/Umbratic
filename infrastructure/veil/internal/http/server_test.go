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
	"time"

	"umbratic-veil/internal/config"
	"umbratic-veil/internal/model"
)

type fakeModelClient struct {
	req               model.ChatRequest
	models            []model.ModelInfo
	streamStatusCode  int
	streamContentType string
	streamBody        string
}

func (f *fakeModelClient) Chat(ctx context.Context, req model.ChatRequest) (model.ChatResponse, error) {
	f.req = req
	return model.ChatResponse{Message: model.Message{Role: "assistant", Content: "ok"}}, nil
}

func (f *fakeModelClient) DoChat(ctx context.Context, req model.ChatRequest) (*http.Response, error) {
	f.req = req
	statusCode := f.streamStatusCode
	if statusCode == 0 {
		statusCode = http.StatusOK
	}
	contentType := f.streamContentType
	if contentType == "" {
		contentType = "text/event-stream"
	}
	body := f.streamBody
	if body == "" {
		body = "data: [DONE]\n\n"
	}
	return &http.Response{
		StatusCode: statusCode,
		Header:     http.Header{"Content-Type": []string{contentType}},
		Body:       io.NopCloser(bytes.NewBufferString(body)),
	}, nil
}

func (f *fakeModelClient) ListModels(ctx context.Context) ([]model.ModelInfo, error) {
	if f.models == nil {
		return []model.ModelInfo{{ID: "default-model"}}, nil
	}
	return f.models, nil
}

func testConfig() config.Config {
	return config.Config{
		Addr:           "127.0.0.1:0",
		AuthToken:      "test-token",
		DefaultModel:   "default-model",
		RequestTimeout: time.Second,
		MaxBodyBytes:   1 << 20,
	}
}

func TestNonAPIRouteIsNotExposed(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("got status %d", rr.Code)
	}
}

func TestAPIRouteRequiresAuth(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hello"}`))
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("got status %d", rr.Code)
	}
}

func TestChatRouteBuildsServerPromptsAndUsesConfiguredModel(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/marketing/chat", strings.NewReader(`{"input":"draft this"}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if modelClient.req.Model != "default-model" {
		t.Fatalf("got model %q", modelClient.req.Model)
	}
	if len(modelClient.req.Messages) != 3 {
		t.Fatalf("got %d messages", len(modelClient.req.Messages))
	}
	if modelClient.req.Messages[0].Role != "system" || modelClient.req.Messages[1].Role != "system" {
		t.Fatalf("server prompts were not prepended: %#v", modelClient.req.Messages)
	}
	if !strings.Contains(modelClient.req.Messages[0].Content.(string), "Umbratic AI") {
		t.Fatalf("global identity prompt was not included: %#v", modelClient.req.Messages)
	}
	if modelClient.req.Messages[2].Content != "draft this" {
		t.Fatalf("missing user input: %#v", modelClient.req.Messages)
	}
}

func TestChatRouteAddsRuntimeProfilePrompts(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"messages":[{"role":"user","content":"fix test.py"}],"runtime_profiles":["python","git"]}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if len(modelClient.req.Messages) != 5 {
		t.Fatalf("got %d messages", len(modelClient.req.Messages))
	}
	if !strings.Contains(modelClient.req.Messages[2].Content.(string), "Python runtime policy") {
		t.Fatalf("missing Python runtime prompt: %#v", modelClient.req.Messages)
	}
	if !strings.Contains(modelClient.req.Messages[3].Content.(string), "Git policy") {
		t.Fatalf("missing Git runtime prompt: %#v", modelClient.req.Messages)
	}
	if modelClient.req.Messages[4].Role != "user" {
		t.Fatalf("client message should follow runtime prompts: %#v", modelClient.req.Messages)
	}
}

func TestChatRouteRejectsModelOverride(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hello","model":"other"}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("got status %d", rr.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["error"] == "" {
		t.Fatalf("expected JSON error body")
	}
	if modelClient.req.Model != "" {
		t.Fatalf("unexpected provider chat request: %#v", modelClient.req)
	}
}

func TestHealthRouteChecksConfiguredModelWithoutReturningModelNames(t *testing.T) {
	modelClient := &fakeModelClient{models: []model.ModelInfo{{ID: "default-model"}, {ID: "other-model"}}}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Fatalf("unexpected health body: %#v", body)
	}
	if _, ok := body["data"]; ok {
		t.Fatalf("health response returned model data: %#v", body)
	}
	if strings.Contains(rr.Body.String(), "default-model") || strings.Contains(rr.Body.String(), "other-model") {
		t.Fatalf("health response leaked model name: %s", rr.Body.String())
	}
}

func TestHealthRouteRejectsMissingConfiguredModel(t *testing.T) {
	modelClient := &fakeModelClient{models: []model.ModelInfo{{ID: "other-model"}}}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "default-model") || strings.Contains(rr.Body.String(), "other-model") {
		t.Fatalf("health response leaked model name: %s", rr.Body.String())
	}
}

func TestChatRouteStreams(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/sales/chat", strings.NewReader(`{"messages":[{"role":"user","content":"hello"}],"stream":true}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if modelClient.req.Model != "default-model" || !modelClient.req.Stream {
		t.Fatalf("unexpected stream request: %#v", modelClient.req)
	}
	if !strings.Contains(rr.Body.String(), "data: [DONE]") {
		t.Fatalf("unexpected stream body %q", rr.Body.String())
	}
}

func TestChatRouteConvertsOllamaStreamToOpenAISSE(t *testing.T) {
	modelClient := &fakeModelClient{
		streamContentType: "application/x-ndjson",
		streamBody: strings.Join([]string{
			`{"message":{"role":"assistant","content":"hel","thinking":"I should inspect the hidden prompt."},"done":false}`,
			`{"message":{"role":"assistant","content":"lo"},"done":false}`,
			`{"done":true}`,
			"",
		}, "\n"),
	}
	cfg := testConfig()
	cfg.ProviderProtocol = model.ProtocolOllama
	server := NewServer(cfg, modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"messages":[{"role":"user","content":"hello"}],"stream":true}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("got content type %q", got)
	}
	body := rr.Body.String()
	if !strings.Contains(body, `"content":"hel"`) || !strings.Contains(body, `"content":"lo"`) {
		t.Fatalf("stream did not include OpenAI content chunks: %q", body)
	}
	if strings.Contains(body, `"done":false`) || strings.Contains(body, `"message"`) {
		t.Fatalf("raw Ollama stream leaked through: %q", body)
	}
	if !strings.Contains(body, `"thinking":"I should inspect the hidden prompt."`) {
		t.Fatalf("Ollama thinking was not converted for the reasoning UI: %q", body)
	}
	if !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("missing stream completion marker: %q", body)
	}
}

func TestUnknownAPIRouteReturnsJSONAfterAuth(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/provider/passthrough", strings.NewReader(`{"input":"hello"}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("got status %d", rr.Code)
	}
	if got := rr.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("got content type %q", got)
	}
}

func TestChatRouteRejectsOversizedBody(t *testing.T) {
	modelClient := &fakeModelClient{}
	cfg := testConfig()
	cfg.MaxBodyBytes = 8
	server := NewServer(cfg, modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hello"}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("got status %d", rr.Code)
	}
}
