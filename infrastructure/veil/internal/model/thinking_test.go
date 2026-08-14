package model

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func boolPointer(value bool) *bool { return &value }

// captureBody runs one chat request against a stub runtime and returns the body
// Veil actually sent, which is the only thing this contract is about.
func captureBody(t *testing.T, mode Mode, chatPath string, handler http.HandlerFunc, req ChatRequest) map[string]any {
	t.Helper()
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == chatPath {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("chat body did not decode: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
			return
		}
		if handler != nil {
			handler(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Mode: mode, BaseURL: server.URL, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Chat(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestVLLMChatCarriesThinkingOnlyOnDirective(t *testing.T) {
	base := ChatRequest{Model: "m", Messages: []Message{{Role: "user", Content: "hi"}}}

	body := captureBody(t, ModeServer, "/v1/chat/completions", nil, base)
	if _, present := body["chat_template_kwargs"]; present {
		t.Fatalf("no directive must leave the body exactly as it was: %#v", body)
	}

	for _, want := range []bool{true, false} {
		request := base
		request.Thinking = boolPointer(want)
		body := captureBody(t, ModeServer, "/v1/chat/completions", nil, request)
		kwargs, ok := body["chat_template_kwargs"].(map[string]any)
		if !ok {
			t.Fatalf("a directive must produce chat_template_kwargs: %#v", body)
		}
		if kwargs["enable_thinking"] != want {
			t.Fatalf("enable_thinking must mirror the directive: %#v", kwargs)
		}
	}
}

func TestVLLMChatOmitsReasoningEffortWhenSuppressed(t *testing.T) {
	// handleChat is what clears the profile on "off"; this is the guarantee it
	// relies on — a cleared effort really does leave the body.
	body := captureBody(t, ModeServer, "/v1/chat/completions", nil, ChatRequest{
		Model:           "m",
		Messages:        []Message{{Role: "user", Content: "hi"}},
		Thinking:        boolPointer(false),
		ReasoningEffort: ReasoningNone,
	})
	if _, present := body["reasoning_effort"]; present {
		t.Fatalf("reasoning_effort must not travel with a thinking-off request: %#v", body)
	}
	if _, present := body["thinking_budget"]; present {
		t.Fatalf("thinking_budget must not travel with a thinking-off request: %#v", body)
	}
}

// llama-server reaches the chat template with the same kwargs vLLM does, so a
// thinking directive travels the same way in both modes.
func TestLocalChatCarriesThinkingOnlyOnDirective(t *testing.T) {
	base := ChatRequest{Model: "m", Messages: []Message{{Role: "user", Content: "hi"}}}

	body := captureBody(t, ModeLocal, "/v1/chat/completions", nil, base)
	if _, present := body["chat_template_kwargs"]; present {
		t.Fatalf("no directive must leave the body exactly as it was: %#v", body)
	}

	for _, want := range []bool{true, false} {
		request := base
		request.Thinking = boolPointer(want)
		body := captureBody(t, ModeLocal, "/v1/chat/completions", nil, request)
		kwargs, ok := body["chat_template_kwargs"].(map[string]any)
		if !ok || kwargs["enable_thinking"] != want {
			t.Fatalf("enable_thinking must mirror the directive: %#v", body)
		}
	}
}

// The prefix count is per model: two models tokenize the same protected prefix
// differently, so a shared key would report one model's count for the other.
func TestPrefixTokenCacheKeyIncludesTheModel(t *testing.T) {
	counts := map[string]int{"big": 400, "small": 100}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"count": counts[request.Model]})
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Mode: ModeServer, BaseURL: server.URL, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	messages := []Message{{Role: "system", Content: "protected"}}
	big := client.PrefixTokens(context.Background(), "same-prefix", "big", messages)
	small := client.PrefixTokens(context.Background(), "same-prefix", "small", messages)
	if big.SystemPromptTokens != 400 || small.SystemPromptTokens != 100 {
		t.Fatalf("each model must get its own count: big=%d small=%d", big.SystemPromptTokens, small.SystemPromptTokens)
	}
}
