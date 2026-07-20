package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"umbratic-veil/internal/config"
	"umbratic-veil/internal/model"
	"umbratic-veil/internal/policy"
)

type fakeModelClient struct {
	req               model.ChatRequest
	models            []model.ModelInfo
	chatErr           error
	chatContent       string
	listErr           error
	streamErr         error
	streamStatusCode  int
	streamContentType string
	streamBody        string
	activateErr       error
	activatedModel    string
	contextLength     int
	contextErr        error
}

func (f *fakeModelClient) ActivateModel(ctx context.Context, modelID string) error {
	f.activatedModel = modelID
	return f.activateErr
}

func (f *fakeModelClient) ContextLength(ctx context.Context, modelID string) (int, error) {
	if f.contextErr != nil {
		return 0, f.contextErr
	}
	if f.contextLength > 0 {
		return f.contextLength, nil
	}
	return 131072, nil
}

func (f *fakeModelClient) Chat(ctx context.Context, req model.ChatRequest) (model.ChatResponse, error) {
	f.req = req
	if f.chatErr != nil {
		return model.ChatResponse{}, f.chatErr
	}
	content := f.chatContent
	if content == "" {
		content = "ok"
	}
	return model.ChatResponse{Message: model.Message{Role: "assistant", Content: content}}, nil
}

func (f *fakeModelClient) DoChat(ctx context.Context, req model.ChatRequest) (*http.Response, error) {
	f.req = req
	if f.streamErr != nil {
		return nil, f.streamErr
	}
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
	if f.listErr != nil {
		return nil, f.listErr
	}
	if f.models == nil {
		return []model.ModelInfo{{ID: "default-model"}}, nil
	}
	return f.models, nil
}

func testConfig() config.Config {
	return config.Config{
		Addr:                   "127.0.0.1:0",
		AuthToken:              "test-token",
		DefaultModel:           "default-model",
		TelemetryEnabled:       true,
		TelemetryRetentionDays: 30,
		RequestTimeout:         time.Second,
		MaxBodyBytes:           1 << 20,
		MaxOutputTokens:        4096,
	}
}

func TestFinalAssembledRequestGuardRejectsBeforeModelCall(t *testing.T) {
	cfg := testConfig()
	cfg.ContextLength = 1000
	client := &fakeModelClient{}
	server := NewServer(cfg, client)
	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"`+strings.Repeat("x", 4000)+`"}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)
	if rr.Code != http.StatusRequestEntityTooLarge || !strings.Contains(rr.Body.String(), "context_overflow_preflight") {
		t.Fatalf("got %d %s", rr.Code, rr.Body.String())
	}
	if len(client.req.Messages) != 0 {
		t.Fatal("model was called despite final guard")
	}
}

func TestContextCompactionRouteUsesProtectedPromptAndEchoesDigest(t *testing.T) {
	cfg := testConfig()
	cfg.ContextLength = 64_000
	client := &fakeModelClient{chatContent: "# Goal and current request\nSummary facts.\n# Constraints and decisions\nConstraints.\n# Work completed\nCompleted work.\n# Files and verification\nVerification facts.\n# Errors or blockers\nNo blockers.\n# Next work\nContinue verification. " + strings.Repeat("bounded facts ", 8)}
	server := NewServer(cfg, client)
	body := fmt.Sprintf(`{"version":1,"route":"engineering","messages":[{"role":"user","content":%q}],"maxSummaryTokens":512,"sourceDigest":"%s"}`, strings.Repeat("source facts ", 200), strings.Repeat("a", 64))
	req := httptest.NewRequest(http.MethodPost, "/api/internal/context/compact", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), strings.Repeat("a", 64)) {
		t.Fatalf("got %d %s", rr.Code, rr.Body.String())
	}
	if len(client.req.Messages) != 2 || client.req.Messages[0].Role != "system" || client.req.Tools != nil {
		t.Fatalf("unexpected compaction request %#v", client.req)
	}
}

func TestContextCompactionRejectsSummaryWithoutRequiredHandoffStructure(t *testing.T) {
	cfg := testConfig()
	client := &fakeModelClient{chatContent: strings.Repeat("generic summary without structure ", 20)}
	server := NewServer(cfg, client)
	body := fmt.Sprintf(`{"version":1,"route":"engineering","messages":[{"role":"user","content":"%s"}],"maxSummaryTokens":512,"sourceDigest":"%s"}`, strings.Repeat("source facts ", 200), strings.Repeat("b", 64))
	req := httptest.NewRequest(http.MethodPost, "/api/internal/context/compact", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadGateway || !strings.Contains(rr.Body.String(), "invalid_compaction_summary") {
		t.Fatalf("got %d %s", rr.Code, rr.Body.String())
	}
}

func TestEffectiveMaxOutputTokensNeverExceedsServerPolicy(t *testing.T) {
	if got := effectiveMaxOutputTokens(1024, 4096); got != 1024 {
		t.Fatalf("got %d", got)
	}
	if got := effectiveMaxOutputTokens(8192, 4096); got != 4096 {
		t.Fatalf("got %d", got)
	}
	if got := effectiveMaxOutputTokens(0, 4096); got != 4096 {
		t.Fatalf("got %d", got)
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

func TestModelConnectActivatesConfiguredModel(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)
	req := httptest.NewRequest(http.MethodPost, "/api/model/connect", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if modelClient.activatedModel != "default-model" {
		t.Fatalf("activated model %q", modelClient.activatedModel)
	}
}

func TestModelContextReturnsEffectiveConfiguredLimit(t *testing.T) {
	cfg := testConfig()
	cfg.ContextLength = 64000
	modelClient := &fakeModelClient{contextLength: 131072}
	server := NewServer(cfg, modelClient)
	req := httptest.NewRequest(http.MethodGet, "/api/model/context", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	var payload map[string]int
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["context_length"] != 64000 || payload["max_output_tokens"] != 4096 {
		t.Fatalf("got context length %d", payload["context_length"])
	}
}

func TestModelContextFallsBackToConfiguredLimitWhenRuntimeMetadataIsUnavailable(t *testing.T) {
	cfg := testConfig()
	cfg.ContextLength = 32000
	modelClient := &fakeModelClient{contextErr: errors.New("metadata unavailable")}
	server := NewServer(cfg, modelClient)
	req := httptest.NewRequest(http.MethodGet, "/api/model/context", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"context_length":32000`) {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
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

func TestAPIRouteRejectsWrongBearerToken(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hello"}`))
	req.Header.Set("Authorization", "Bearer wrong-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("got status %d", rr.Code)
	}
}

func TestChatRouteRequiresPost(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodGet, "/api/engineering/chat", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("got status %d", rr.Code)
	}
}

func TestChatRouteBuildsServerPromptsAndUsesConfiguredModel(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/marketing/chat", strings.NewReader(`{"input":"draft this","max_output_tokens":1024}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if modelClient.req.Model != "default-model" {
		t.Fatalf("got model %q", modelClient.req.Model)
	}
	if modelClient.req.MaxOutputTokens != 1024 {
		t.Fatalf("output allowance was not forwarded: %#v", modelClient.req)
	}
	if len(modelClient.req.Messages) != 3 {
		t.Fatalf("got %d messages", len(modelClient.req.Messages))
	}
	if modelClient.req.Messages[0].Role != "system" || modelClient.req.Messages[1].Role != "system" {
		t.Fatalf("server prompts were not prepended: %#v", modelClient.req.Messages)
	}
	if !strings.Contains(modelClient.req.Messages[0].Content.(string), "Umbratic") {
		t.Fatalf("global identity prompt was not included: %#v", modelClient.req.Messages)
	}
	if modelClient.req.Messages[2].Content != "draft this" {
		t.Fatalf("missing user input: %#v", modelClient.req.Messages)
	}
}

func TestChatRoutesSignalRequiredWorkspaceEvidence(t *testing.T) {
	tests := []struct {
		path    string
		message string
		want    string
	}{
		{"/api/engineering/chat", "Can you create a hello world script and verify it works?", policy.ActionChangeAndExecute},
		{"/api/engineering/chat", "can you write me a markdown with suggestions to improve it", policy.ActionChange},
		{"/api/engineering/chat", "I want you to look at each file and describe exactly what each is", policy.ActionInspect},
		{"/api/marketing/chat", "Create a launch brief file", policy.ActionChange},
		{"/api/sales/chat", "Create a QBR deck", policy.ActionChange},
	}

	for _, tt := range tests {
		t.Run(tt.path+"/"+tt.want, func(t *testing.T) {
			modelClient := &fakeModelClient{}
			server := NewServer(testConfig(), modelClient)
			body := fmt.Sprintf(`{"messages":[{"role":"user","content":%q}],"tools":[{"type":"function","function":{"name":"edit"}},{"type":"function","function":{"name":"command"}}]}`, tt.message)
			req := httptest.NewRequest(http.MethodPost, tt.path, strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer test-token")
			rr := httptest.NewRecorder()
			server.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
			}
			if got := rr.Header().Get(actionRequiredHeader); got != tt.want {
				t.Fatalf("got action requirement %q, want %q", got, tt.want)
			}
		})
	}
}

func TestChatRouteAddsServerOwnedSkillCatalogPrompt(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"messages":[{"role":"user","content":"fix test.py"}],"skills":[{"id":"python","name":"Python","description":"Use for Python work.","source":"system"}]}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if len(modelClient.req.Messages) != 4 {
		t.Fatalf("got %d messages", len(modelClient.req.Messages))
	}
	if !strings.Contains(modelClient.req.Messages[2].Content.(string), "read_skill") {
		t.Fatalf("missing skill-use prompt: %#v", modelClient.req.Messages)
	}
	if !strings.Contains(modelClient.req.Messages[2].Content.(string), `"id":"python"`) {
		t.Fatalf("missing Python skill metadata: %#v", modelClient.req.Messages)
	}
	if modelClient.req.Messages[3].Role != "user" {
		t.Fatalf("client message should follow skill prompt: %#v", modelClient.req.Messages)
	}
}

func TestChatRouteAddsSelectedTemplateMetadata(t *testing.T) {
	registryPath := t.TempDir() + "/templates.json"
	if err := os.WriteFile(registryPath, []byte(`{
		"templates": [{
			"id": "sales-quarterly-review",
			"kind": "powerpoint",
			"displayName": "Sales Quarterly Review",
			"serverKey": "templates/powerpoint/sales-quarterly-review",
			"version": "2026-06",
			"tags": ["sales", "qbr"],
			"description": "Quarterly sales review deck.",
			"available": true,
			"checksum": "sha256:abc",
			"routes": ["sales/chat"]
		}]
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig()
	cfg.TemplateRegistryPath = registryPath
	modelClient := &fakeModelClient{}
	server := NewServer(cfg, modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/sales/chat", strings.NewReader(`{"messages":[{"role":"user","content":"Create a QBR deck."}]}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if len(modelClient.req.Messages) != 4 {
		t.Fatalf("got %d messages: %#v", len(modelClient.req.Messages), modelClient.req.Messages)
	}
	templatePrompt, ok := modelClient.req.Messages[2].Content.(string)
	if !ok {
		t.Fatalf("template prompt was not string: %#v", modelClient.req.Messages[2])
	}
	if !strings.Contains(templatePrompt, "sales-quarterly-review") || !strings.Contains(templatePrompt, "serverKey: templates/powerpoint/sales-quarterly-review") {
		t.Fatalf("template metadata was not injected: %s", templatePrompt)
	}
	if modelClient.req.Messages[3].Role != "user" {
		t.Fatalf("client message should follow template prompt: %#v", modelClient.req.Messages)
	}
}

func TestChatRouteHidesTemplateRegistryLoadErrors(t *testing.T) {
	cfg := testConfig()
	cfg.TemplateRegistryPath = t.TempDir() + "/missing.json"
	modelClient := &fakeModelClient{}
	server := NewServer(cfg, modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/sales/chat", strings.NewReader(`{"input":"Create a deck."}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "missing.json") {
		t.Fatalf("registry path leaked in error: %s", rr.Body.String())
	}
	if modelClient.req.Model != "" {
		t.Fatalf("unexpected provider request: %#v", modelClient.req)
	}
}

func selectiveTelemetryBody() string {
	return `{
		"schemaVersion": 4,
		"exportedAt": "2026-01-01T00:00:00.000Z",
		"productEvents": [{
			"id": "event-1",
			"type": "review.opened",
			"at": "2026-01-01T00:00:00.000Z",
			"taskId": "task-1",
			"data": {"scope": "task"}
		}],
		"tasks": [{
			"id": "task-1",
			"chatId": "chat-1",
			"status": "completed",
			"feedback": [{
				"messageId": "assistant-1",
				"rating": "bad",
				"comment": "Missed the requested edge case.",
				"conversation": [
					{"role": "user", "content": "Fix the parser edge case.", "taskId": "task-1"},
					{"role": "assistant", "content": "I updated the parser.", "taskId": "task-1", "messageId": "assistant-1"}
				]
			}],
			"failedTools": [{
				"id": "tool-1",
				"toolKind": "edit",
				"input": {"filePath": "parser.ts", "oldText": "a", "newText": "b"},
				"response": {"stdout": "", "stderr": "oldText was not found", "exitCode": 1}
			}],
			"contextTriggers": [{"threshold": 75, "estimatedTokens": 750, "contextLength": 1000}]
		}]
	}`
}

func TestTelemetryRouteAcceptsSelectiveBundleAndPersistsIt(t *testing.T) {
	cfg := testConfig()
	cfg.TelemetryStorePath = t.TempDir()
	cfg.TelemetryRetentionDays = 14
	modelClient := &fakeModelClient{}
	server := NewServer(cfg, modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/telemetry", strings.NewReader(selectiveTelemetryBody()))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["acceptedTasks"] != float64(1) || response["acceptedEvents"] != float64(1) || response["stored"] != true || response["retentionDays"] != float64(14) {
		t.Fatalf("unexpected telemetry response: %#v", response)
	}
	entries, err := os.ReadDir(cfg.TelemetryStorePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected one stored telemetry file, got %d", len(entries))
	}
	stored, err := os.ReadFile(cfg.TelemetryStorePath + "/" + entries[0].Name())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(stored), "Fix the parser edge case.") || !strings.Contains(string(stored), "oldText was not found") {
		t.Fatalf("stored telemetry did not contain selective feedback and failure content: %s", stored)
	}
	if strings.Contains(string(stored), "raw secret prompt") {
		t.Fatalf("stored telemetry contained raw prompt text: %s", stored)
	}
	if modelClient.req.Model != "" {
		t.Fatalf("telemetry route unexpectedly called model: %#v", modelClient.req)
	}
}

func TestTelemetryRouteRejectsRawPromptFields(t *testing.T) {
	modelClient := &fakeModelClient{}
	server := NewServer(testConfig(), modelClient)
	body := strings.Replace(selectiveTelemetryBody(), `"id": "task-1",`, `"id": "task-1", "prompt": "raw secret prompt",`, 1)

	req := httptest.NewRequest(http.MethodPost, "/api/telemetry", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "raw task field") || strings.Contains(rr.Body.String(), "raw secret prompt") {
		t.Fatalf("unexpected validation response: %s", rr.Body.String())
	}
	if modelClient.req.Model != "" {
		t.Fatalf("telemetry route unexpectedly called model: %#v", modelClient.req)
	}
}

func TestTelemetryRouteObeysAdminDisablePolicy(t *testing.T) {
	cfg := testConfig()
	cfg.TelemetryEnabled = false
	cfg.TelemetryStorePath = t.TempDir()
	modelClient := &fakeModelClient{}
	server := NewServer(cfg, modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/telemetry", strings.NewReader(selectiveTelemetryBody()))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	entries, err := os.ReadDir(cfg.TelemetryStorePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("disabled telemetry route wrote files: %#v", entries)
	}
	if modelClient.req.Model != "" {
		t.Fatalf("telemetry route unexpectedly called model: %#v", modelClient.req)
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

func TestHealthRouteRequiresGetAndSanitizesListErrors(t *testing.T) {
	modelClient := &fakeModelClient{listErr: errors.New("provider leaked model default-model")}
	server := NewServer(testConfig(), modelClient)

	post := httptest.NewRequest(http.MethodPost, "/api/health", nil)
	post.Header.Set("Authorization", "Bearer test-token")
	postRecorder := httptest.NewRecorder()
	server.ServeHTTP(postRecorder, post)
	if postRecorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("got status %d for POST", postRecorder.Code)
	}

	get := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	get.Header.Set("Authorization", "Bearer test-token")
	getRecorder := httptest.NewRecorder()
	server.ServeHTTP(getRecorder, get)
	if getRecorder.Code != http.StatusBadGateway {
		t.Fatalf("got status %d body %s", getRecorder.Code, getRecorder.Body.String())
	}
	if strings.Contains(getRecorder.Body.String(), "default-model") {
		t.Fatalf("health error leaked provider details: %s", getRecorder.Body.String())
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

func TestChatRouteSanitizesModelChatErrors(t *testing.T) {
	modelClient := &fakeModelClient{chatErr: errors.New("runtime says token=secret and model default-model failed")}
	server := NewServer(testConfig(), modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hello"}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("got status %d", rr.Code)
	}
	if strings.Contains(rr.Body.String(), "secret") || strings.Contains(rr.Body.String(), "default-model") {
		t.Fatalf("model error leaked details: %s", rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"code":"model_service_unavailable"`) {
		t.Fatalf("missing safe failure classification: %s", rr.Body.String())
	}
}

func TestChatRouteSanitizesStreamErrorsAndNonSuccessResponses(t *testing.T) {
	for name, modelClient := range map[string]*fakeModelClient{
		"request error": {streamErr: errors.New("runtime dial leaked host")},
		"bad status":    {streamStatusCode: http.StatusForbidden, streamBody: "secret provider body"},
	} {
		t.Run(name, func(t *testing.T) {
			var diagnostic bytes.Buffer
			previousOutput := log.Writer()
			previousFlags := log.Flags()
			log.SetOutput(&diagnostic)
			log.SetFlags(0)
			t.Cleanup(func() {
				log.SetOutput(previousOutput)
				log.SetFlags(previousFlags)
			})
			server := NewServer(testConfig(), modelClient)
			req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hello","stream":true}`))
			req.Header.Set("Authorization", "Bearer test-token")
			rr := httptest.NewRecorder()
			server.ServeHTTP(rr, req)

			if rr.Code != http.StatusBadGateway {
				t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
			}
			if strings.Contains(rr.Body.String(), "secret") || strings.Contains(rr.Body.String(), "runtime") {
				t.Fatalf("stream error leaked details: %s", rr.Body.String())
			}
			if name == "bad status" {
				if !strings.Contains(rr.Body.String(), `"code":"model_service_rejected"`) ||
					!strings.Contains(rr.Body.String(), `"upstreamStatus":403`) {
					t.Fatalf("missing upstream classification: %s", rr.Body.String())
				}
			}
			logged := diagnostic.String()
			for _, expected := range []string{"VEIL_DIAGNOSTIC", `"event":"model.request_failed"`, `"requestBytes":`, `"maxOutputTokens":`} {
				if !strings.Contains(logged, expected) {
					t.Fatalf("missing safe diagnostic %q in %s", expected, logged)
				}
			}
			if strings.Contains(logged, "hello") || strings.Contains(logged, "secret provider body") {
				t.Fatalf("diagnostic leaked request or response content: %s", logged)
			}
		})
	}
}

func TestChatRouteDistinguishesModelTimeouts(t *testing.T) {
	modelClient := &fakeModelClient{streamErr: model.ProviderError{Kind: model.ProviderFailureTimeout}}
	server := NewServer(testConfig(), modelClient)
	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hello","stream":true}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusGatewayTimeout || !strings.Contains(rr.Body.String(), `"code":"model_service_timeout"`) {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
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
