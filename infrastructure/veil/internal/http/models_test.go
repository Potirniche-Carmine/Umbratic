package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"umbratic-veil/internal/config"
)

func registryConfig() config.Config {
	cfg := testConfig()
	cfg.ModelSelectionEnabled = true
	cfg.Models = []config.ModelEntry{
		{ID: "default-model", ProviderBaseURL: "http://127.0.0.1:8001/v1", Display: "Qwen 32B", Reasoning: true, ContextLength: 98304},
		{ID: "small", ProviderBaseURL: "http://127.0.0.1:8002/v1"},
	}
	return cfg
}

func authorizedRequest(method, path, body string) *http.Request {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	return req
}

func decodeModelList(t *testing.T, response *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	var payload struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Models
}

func TestModelsRouteRequiresAuthAndGET(t *testing.T) {
	server := NewServer(testConfig(), &fakeModelClient{})

	unauthorized := httptest.NewRecorder()
	server.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/api/models", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("the model list is product-authenticated: %d", unauthorized.Code)
	}

	wrongMethod := httptest.NewRecorder()
	server.ServeHTTP(wrongMethod, authorizedRequest(http.MethodPost, "/api/models", "{}"))
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", wrongMethod.Code)
	}
}

func TestModelsRouteListsTheSingleModelDeployment(t *testing.T) {
	server := NewServer(testConfig(), &fakeModelClient{})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, authorizedRequest(http.MethodGet, "/api/models", ""))

	models := decodeModelList(t, response)
	if len(models) != 1 {
		t.Fatalf("a deployment with no registry still lists its one model: %#v", models)
	}
	if models[0]["id"] != "default-model" || models[0]["display"] != "default-model" {
		t.Fatalf("a missing display falls back to the id: %#v", models[0])
	}
	if models[0]["default"] != true || models[0]["available"] != true {
		t.Fatalf("the configured model must read as the available default: %#v", models[0])
	}
}

func TestModelsRouteReportsShapeAndLiveAvailability(t *testing.T) {
	client := &fakeModelClient{
		available:         map[string]bool{"default-model": true, "small": false},
		thinkingSupported: map[string]bool{"default-model": true},
	}
	server := NewServer(registryConfig(), client)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, authorizedRequest(http.MethodGet, "/api/models", ""))

	models := decodeModelList(t, response)
	if len(models) != 2 {
		t.Fatalf("every registered model is listed, running or not: %#v", models)
	}
	first := models[0]
	if first["id"] != "default-model" || first["display"] != "Qwen 32B" || first["context_length"] != float64(98304) {
		t.Fatalf("registry metadata must reach the client: %#v", first)
	}
	capabilities, _ := first["capabilities"].(map[string]any)
	if capabilities["reasoning"] != true {
		t.Fatalf("capabilities must be reported per model: %#v", first)
	}
	if first["available"] != true || first["default"] != true {
		t.Fatalf("the running default must say so: %#v", first)
	}
	second := models[1]
	if second["available"] != false || second["default"] != false {
		t.Fatalf("a stopped model stays listed and unavailable: %#v", second)
	}
	if _, present := second["context_length"]; present {
		t.Fatalf("an undeclared window is omitted rather than reported as zero: %#v", second)
	}
}

func TestModelsRouteCachesAvailabilityProbes(t *testing.T) {
	client := &fakeModelClient{available: map[string]bool{"default-model": true, "small": true}}
	server := NewServer(registryConfig(), client)
	for range 3 {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, authorizedRequest(http.MethodGet, "/api/models", ""))
		decodeModelList(t, response)
	}
	if len(client.availableCalls) != 2 {
		t.Fatalf("repeat listings must reuse one probe round: %#v", client.availableCalls)
	}
}

func TestFeaturesFollowTheRegistryState(t *testing.T) {
	always := Features(false, false)
	for _, name := range []string{"models.list", "chat.thinking_toggle"} {
		if !slices.Contains(always, name) {
			t.Fatalf("%q is advertised on every build: %#v", name, always)
		}
	}
	if slices.Contains(always, "chat.model_selection") {
		t.Fatalf("model selection must not be advertised without a registry: %#v", always)
	}
	if !slices.Contains(Features(false, true), "chat.model_selection") {
		t.Fatal("a configured registry must advertise chat.model_selection")
	}
}

func TestHealthAdvertisesModelSelectionOnlyWithARegistry(t *testing.T) {
	read := func(cfg config.Config) []string {
		server := NewServer(cfg, &fakeModelClient{})
		response := httptest.NewRecorder()
		server.ServeHTTP(response, authorizedRequest(http.MethodGet, "/api/health", ""))
		if response.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
		}
		var payload struct {
			Features []string `json:"features"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Features
	}

	if slices.Contains(read(testConfig()), "chat.model_selection") {
		t.Fatal("an unconfigured deployment must not invite a client to send model")
	}
	registry := registryConfig()
	registry.Models[0].ID = "default-model"
	if !slices.Contains(read(registry), "chat.model_selection") {
		t.Fatal("a configured registry must invite it")
	}
}

func TestChatRoutesToTheSelectedModel(t *testing.T) {
	client := &fakeModelClient{}
	server := NewServer(registryConfig(), client)

	response := httptest.NewRecorder()
	server.ServeHTTP(response, authorizedRequest(http.MethodPost, "/api/engineering/chat", `{"input":"hi","model":"small"}`))
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	if client.req.Model != "small" {
		t.Fatalf("the chosen model must reach the runtime call: %q", client.req.Model)
	}

	fallback := httptest.NewRecorder()
	server.ServeHTTP(fallback, authorizedRequest(http.MethodPost, "/api/engineering/chat", `{"input":"hi"}`))
	if client.req.Model != "default-model" {
		t.Fatalf("no choice means the configured default: %q", client.req.Model)
	}

	rejected := httptest.NewRecorder()
	server.ServeHTTP(rejected, authorizedRequest(http.MethodPost, "/api/engineering/chat", `{"input":"hi","model":"absent"}`))
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("an unregistered model must be refused: %d", rejected.Code)
	}
}

func TestChatThinkingDirectiveReachesTheRequest(t *testing.T) {
	cfg := registryConfig()
	cfg.Generation.ReasoningEffort = "high"
	budget := 4096
	cfg.Generation.ThinkingTokenBudget = &budget
	client := &fakeModelClient{}
	server := NewServer(cfg, client)

	send := func(body string) {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, authorizedRequest(http.MethodPost, "/api/engineering/chat", body))
		if response.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
		}
	}

	send(`{"input":"hi"}`)
	if client.req.Thinking != nil {
		t.Fatal("no directive must leave the request as it was")
	}
	if client.req.ReasoningEffort != "high" || client.req.ThinkingTokenBudget == nil {
		t.Fatal("the server profile applies when nothing overrides it")
	}

	send(`{"input":"hi","thinking":"on"}`)
	if client.req.Thinking == nil || !*client.req.Thinking {
		t.Fatal("thinking on must force the directive on")
	}
	if client.req.ReasoningEffort != "high" {
		t.Fatal("thinking on keeps the server's reasoning profile")
	}

	send(`{"input":"hi","thinking":"off"}`)
	if client.req.Thinking == nil || *client.req.Thinking {
		t.Fatal("thinking off must force the directive off")
	}
	if client.req.ReasoningEffort != "none" || client.req.ThinkingTokenBudget != nil {
		t.Fatalf("thinking off must unwind the reasoning profile too: %q %v", client.req.ReasoningEffort, client.req.ThinkingTokenBudget)
	}

	send(`{"input":"hi","thinking":"whenever"}`)
	if client.req.Thinking != nil {
		t.Fatal("an unknown directive must behave as no directive")
	}
}

func TestModelContextAcceptsAModelParameter(t *testing.T) {
	cfg := registryConfig()
	cfg.Models[1].ContextLength = 8192
	client := &fakeModelClient{contextLength: 200000}
	server := NewServer(cfg, client)

	read := func(path string) int {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, authorizedRequest(http.MethodGet, path, ""))
		if response.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
		}
		var payload struct {
			ContextLength int `json:"context_length"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.ContextLength
	}

	if got := read("/api/model/context?model=small"); got != 8192 {
		t.Fatalf("the named model's declared window must win: %d", got)
	}
	if got := read("/api/model/context?model=default-model"); got != 98304 {
		t.Fatalf("the default entry's window must win: %d", got)
	}
	if got := read("/api/model/context?model=absent"); got != 98304 {
		t.Fatalf("an unknown id falls back to the default rather than failing: %d", got)
	}
}
