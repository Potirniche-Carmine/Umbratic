package model

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVLLMClientChat(t *testing.T) {
	var got struct {
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
		Stream   bool      `json:"stream"`
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer redacted-test-key" {
			t.Fatalf("missing auth header")
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{
				map[string]any{
					"message": map[string]string{
						"role":    "assistant",
						"content": "done",
					},
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewVLLMClient(VLLMConfig{
		BaseURL: server.URL,
		APIKey:  "redacted-test-key",
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := client.Chat(context.Background(), ChatRequest{
		Model:    "route-model",
		Messages: []Message{{Role: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "route-model" || got.Stream {
		t.Fatalf("unexpected runtime request: %#v", got)
	}
	if resp.Message.Content != "done" {
		t.Fatalf("unexpected response: %#v", resp)
	}
}

func TestOllamaClientChat(t *testing.T) {
	var got struct {
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
		Stream   bool      `json:"stream"`
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"message": map[string]string{
				"role":    "assistant",
				"content": "ollama done",
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{
		Protocol: ProtocolOllama,
		BaseURL:  server.URL,
		Timeout:  time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := client.Chat(context.Background(), ChatRequest{
		Model:    "llama3",
		Messages: []Message{{Role: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "llama3" || got.Stream {
		t.Fatalf("unexpected runtime request: %#v", got)
	}
	if resp.Message.Content != "ollama done" {
		t.Fatalf("unexpected response: %#v", resp)
	}
}

func TestListModelsNormalizesVLLMAndOllamaPayloads(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{
				map[string]string{"id": "alpha"},
				map[string]string{"id": "beta"},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{BaseURL: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "alpha" || models[1].ID != "beta" {
		t.Fatalf("unexpected models: %#v", models)
	}
}

func TestParseProviderProtocolAliases(t *testing.T) {
	cases := map[string]ProviderProtocol{
		"":       ProtocolVLLM,
		"vllm":   ProtocolVLLM,
		"ollama": ProtocolOllama,
	}
	for input, want := range cases {
		got, err := ParseProviderProtocol(input)
		if err != nil {
			t.Fatalf("%q returned error: %v", input, err)
		}
		if got != want {
			t.Fatalf("%q got %q, want %q", input, got, want)
		}
	}
}

func TestChatCompletionsURLAvoidsDuplicateV1(t *testing.T) {
	got, err := chatCompletionsURL("http://example.test/v1", "")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://example.test/v1/chat/completions" {
		t.Fatalf("got %q", got)
	}
}

func TestProviderEndpointURLAvoidsDuplicateAPI(t *testing.T) {
	got, err := providerEndpointURL("http://example.test/api", "", "api/chat")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://example.test/api/chat" {
		t.Fatalf("got %q", got)
	}
}

func TestNewClientRejectsInvalidRuntimeConfig(t *testing.T) {
	if _, err := NewClient(ClientConfig{BaseURL: "file:///tmp/model.sock"}); err == nil {
		t.Fatal("expected non-http base URL rejection")
	}
	client, err := NewClient(ClientConfig{Protocol: ProviderProtocol("raw"), BaseURL: "http://provider.test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.DoChat(context.Background(), ChatRequest{}); err == nil {
		t.Fatal("expected unsupported protocol rejection when issuing a chat request")
	}
	if _, err := providerEndpointURL("", "", "v1/chat/completions"); err == nil {
		t.Fatal("expected missing base URL rejection")
	}
	if _, err := providerEndpointURL("http://base.test", "https://", "v1/chat/completions"); err == nil {
		t.Fatal("expected malformed endpoint URL rejection")
	}
}

func TestVLLMDoChatForwardsToolsAndToolChoice(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/custom/chat" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`data: [DONE]`))
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{
		BaseURL:          server.URL,
		ChatEndpointPath: "/custom/chat",
		Timeout:          time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.DoChat(context.Background(), ChatRequest{
		Model:      "model-a",
		Messages:   []Message{{Role: "user", Content: "hello"}},
		Stream:     true,
		Tools:      []any{map[string]any{"type": "function"}},
		ToolChoice: "auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if got["model"] != "model-a" || got["stream"] != true || got["tools"] == nil || got["tool_choice"] != "auto" {
		t.Fatalf("unexpected request body: %#v", got)
	}
}

func TestOllamaDoChatConvertsContentPartsAndOmitsToolChoice(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"message":{"role":"assistant","content":"ok"}}`))
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Protocol: ProtocolOllama, BaseURL: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.DoChat(context.Background(), ChatRequest{
		Model: "llama3",
		Messages: []Message{{
			Role: "user",
			Content: []any{
				map[string]any{"type": "text", "text": "first"},
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,abc"}},
				map[string]any{"type": "text", "text": "second"},
			},
		}},
		Stream:     false,
		Tools:      []any{map[string]any{"type": "function"}},
		ToolChoice: "auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	messages := got["messages"].([]any)
	first := messages[0].(map[string]any)
	if first["content"] != "first\n\nsecond" {
		t.Fatalf("unexpected Ollama content: %#v", first["content"])
	}
	if _, ok := got["tool_choice"]; ok {
		t.Fatalf("Ollama request should not include tool_choice: %#v", got)
	}
	if got["tools"] == nil {
		t.Fatalf("Ollama tools were not forwarded: %#v", got)
	}
}

func TestListModelsNormalizesOllamaPayloadsAndDedupes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tags" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"models": []any{
				map[string]string{"name": "llama3"},
				map[string]string{"model": "gemma"},
				"llama3",
				map[string]string{"id": "mistral"},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Protocol: ProtocolOllama, BaseURL: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 3 || models[0].ID != "llama3" || models[1].ID != "gemma" || models[2].ID != "mistral" {
		t.Fatalf("unexpected models: %#v", models)
	}
}

func TestWriteOpenAIChatSSEConvertsOllamaToolCallsAndDone(t *testing.T) {
	src := strings.NewReader(strings.Join([]string{
		`{"message":{"role":"assistant","content":"hi","tool_calls":[{"function":{"name":"read","arguments":{"filePath":"README.md"}}}]},"done":false}`,
		"",
	}, "\n"))
	var dst bytes.Buffer
	if err := WriteOpenAIChatSSE(ProtocolOllama, &dst, src); err != nil {
		t.Fatal(err)
	}
	body := dst.String()
	if !strings.Contains(body, `"role":"assistant"`) || !strings.Contains(body, `"content":"hi"`) {
		t.Fatalf("missing assistant delta: %q", body)
	}
	if !strings.Contains(body, `"name":"read"`) || !strings.Contains(body, `"{\"filePath\":\"README.md\"}"`) {
		t.Fatalf("missing converted tool call: %q", body)
	}
	if !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("missing synthesized done marker: %q", body)
	}
}

func TestWriteOpenAIChatSSERejectsNonAssistantOllamaMessages(t *testing.T) {
	err := WriteOpenAIChatSSE(ProtocolOllama, &bytes.Buffer{}, strings.NewReader(`{"message":{"role":"user","content":"bad"},"done":false}`))
	if err == nil {
		t.Fatal("expected non-assistant message error")
	}
}

func TestWriteOpenAIChatSSERejectsUnsupportedProtocol(t *testing.T) {
	err := WriteOpenAIChatSSE(ProviderProtocol("raw"), &bytes.Buffer{}, strings.NewReader(""))
	if err == nil {
		t.Fatal("expected unsupported protocol error")
	}
}
