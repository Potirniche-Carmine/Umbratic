package model

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
