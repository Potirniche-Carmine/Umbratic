package model

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// stubRuntime is one model's process: it answers /v1/models with its own id and
// records the chat bodies it was sent.
type stubRuntime struct {
	server *httptest.Server
	bodies chan map[string]any
}

func newStubRuntime(t *testing.T, modelID string) *stubRuntime {
	t.Helper()
	runtime := &stubRuntime{bodies: make(chan map[string]any, 8)}
	runtime.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"id": modelID}}})
		case "/v1/chat/completions":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			runtime.bodies <- body
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(runtime.server.Close)
	return runtime
}

func TestRegistryRoutesChatToTheNamedModel(t *testing.T) {
	big := newStubRuntime(t, "big")
	small := newStubRuntime(t, "small")

	registry, err := NewRegistry(ModeServer, "big", "", []RegistrySpec{
		{ID: "big", BaseURL: big.server.URL},
		{ID: "small", BaseURL: small.server.URL},
	}, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := registry.Chat(context.Background(), ChatRequest{Model: "small", Messages: []Message{{Role: "user", Content: "hi"}}}); err != nil {
		t.Fatal(err)
	}
	select {
	case body := <-small.bodies:
		if body["model"] != "small" {
			t.Fatalf("the named model must reach its own runtime: %#v", body)
		}
	default:
		t.Fatal("the request never reached the small model's runtime")
	}
	if len(big.bodies) != 0 {
		t.Fatal("the default runtime must not see a request addressed elsewhere")
	}
}

func TestRegistryAvailabilityIsPerRuntime(t *testing.T) {
	big := newStubRuntime(t, "big")
	stopped := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer stopped.Close()

	registry, err := NewRegistry(ModeServer, "big", "", []RegistrySpec{
		{ID: "big", BaseURL: big.server.URL},
		{ID: "small", BaseURL: stopped.URL},
	}, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	if available, err := registry.Available(context.Background(), "big"); err != nil || !available {
		t.Fatalf("a running model must read as available: %v %v", available, err)
	}
	if available, _ := registry.Available(context.Background(), "small"); available {
		t.Fatal("a stopped model must not read as available")
	}
	if available, _ := registry.Available(context.Background(), "unregistered"); available {
		t.Fatal("an unregistered id must not read as available")
	}
}

func TestRegistryServerThinkingSupportComesFromTheEntry(t *testing.T) {
	big := newStubRuntime(t, "big")
	registry, err := NewRegistry(ModeServer, "big", "", []RegistrySpec{
		{ID: "big", BaseURL: big.server.URL, Reasoning: true},
		{ID: "plain", BaseURL: big.server.URL},
	}, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !registry.ThinkingSupported(context.Background(), "big") {
		t.Fatal("a declared reasoning model must support the directive")
	}
	if registry.ThinkingSupported(context.Background(), "plain") {
		t.Fatal("an undeclared model must not")
	}
}

// A local model's thinking capability comes from the catalog the desktop
// downloaded its weights out of, the same way a server model's comes from the
// administrator's registry. llama-server does not expose the fact, and a
// directive that reaches a template which ignores it reads, in a trace, as a
// directive that was honoured.
func TestRegistryLocalThinkingSupportComesFromTheEntry(t *testing.T) {
	var chatBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&chatBody)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	registry, err := NewRegistry(ModeLocal, "thinker", "", []RegistrySpec{
		{ID: "thinker", BaseURL: server.URL, Reasoning: true},
	}, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	request := ChatRequest{Model: "thinker", Messages: []Message{{Role: "user", Content: "hi"}}, Thinking: boolPointer(true)}
	if _, err := registry.Chat(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	kwargs, _ := chatBody["chat_template_kwargs"].(map[string]any)
	if kwargs["enable_thinking"] != true {
		t.Fatalf("a declared reasoning model must receive the directive: %#v", chatBody)
	}

	plain, err := NewRegistry(ModeLocal, "plain", "", []RegistrySpec{{ID: "plain", BaseURL: server.URL}}, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	chatBody = nil
	if _, err := plain.Chat(context.Background(), ChatRequest{Model: "plain", Messages: []Message{{Role: "user", Content: "hi"}}, Thinking: boolPointer(true)}); err != nil {
		t.Fatal(err)
	}
	if _, present := chatBody["chat_template_kwargs"]; present {
		t.Fatalf("an undeclared model must not be sent a thinking directive: %#v", chatBody)
	}
}

// Every runtime call carries the configured bearer, which is what keeps a
// second process on the box from driving the llama-server the desktop started.
func TestRegistryClientsCarryTheProviderBearer(t *testing.T) {
	authorizations := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorizations <- r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"id": "local"}}})
	}))
	defer server.Close()

	registry, err := NewRegistry(ModeLocal, "local", "run-secret", []RegistrySpec{{ID: "local", BaseURL: server.URL}}, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.ListModels(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := <-authorizations; got != "Bearer run-secret" {
		t.Fatalf("runtime call was not authenticated: %q", got)
	}
}

func TestNewRegistryRequiresTheDefaultModel(t *testing.T) {
	if _, err := NewRegistry(ModeServer, "absent", "", []RegistrySpec{{ID: "big", BaseURL: "http://127.0.0.1:8001/v1"}}, time.Second); err == nil {
		t.Fatal("a default outside the registry must fail at startup, not at request time")
	}
	if _, err := NewRegistry(ModeServer, "big", "", nil, time.Second); err == nil {
		t.Fatal("an empty registry must fail at startup")
	}
}
