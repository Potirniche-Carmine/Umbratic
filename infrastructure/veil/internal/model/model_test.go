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
		if r.Header.Get("Authorization") != "" {
			t.Fatalf("local runtime request included authorization")
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

	client, err := NewClient(ClientConfig{
		Protocol: ProtocolVLLM,
		BaseURL:  server.URL,
		Timeout:  time.Second,
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
		Options  struct {
			NumCtx int `json:"num_ctx"`
		} `json:"options"`
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
		Protocol:      ProtocolOllama,
		BaseURL:       server.URL,
		ContextLength: 64000,
		Timeout:       time.Second,
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
	if got.Options.NumCtx != 64000 {
		t.Fatalf("unexpected Ollama context length: %#v", got.Options)
	}
	if resp.Message.Content != "ollama done" {
		t.Fatalf("unexpected response: %#v", resp)
	}
}

func TestOllamaMessagesConsolidateSystemMessagesAtBeginning(t *testing.T) {
	messages := ollamaMessages([]Message{
		{Role: "system", Content: "Global policy."},
		{Role: "user", Content: "Skill catalog."},
		{Role: "system", Content: "Route and template policy."},
		{Role: "user", Content: "Hello."},
	})

	if len(messages) != 3 {
		t.Fatalf("got %d messages: %#v", len(messages), messages)
	}
	if messages[0]["role"] != "system" || messages[0]["content"] != "Global policy.\n\nRoute and template policy." {
		t.Fatalf("system messages were not consolidated first: %#v", messages)
	}
	if messages[1]["role"] != "user" || messages[1]["content"] != "Skill catalog." {
		t.Fatalf("non-system message order changed: %#v", messages)
	}
	for _, message := range messages[1:] {
		if message["role"] == "system" {
			t.Fatalf("found a non-leading system message: %#v", messages)
		}
	}
}

func TestOllamaMessagesConvertStructuredOpenAIToolHistory(t *testing.T) {
	messages := ollamaMessages([]Message{
		{Role: "user", Content: "Read the file."},
		{Role: "assistant", Content: "", ToolCalls: []any{
			map[string]any{
				"id":   "call-1",
				"type": "function",
				"function": map[string]any{
					"name":      "read",
					"arguments": `{"filePath":"README.md"}`,
				},
			},
		}},
		{Role: "tool", Content: "file contents", ToolCallID: "call-1"},
	})

	if len(messages) != 3 {
		t.Fatalf("got %d messages: %#v", len(messages), messages)
	}
	toolCalls, ok := messages[1]["tool_calls"].([]map[string]any)
	if !ok || len(toolCalls) != 1 {
		t.Fatalf("assistant tool calls were not converted: %#v", messages[1])
	}
	function := toolCalls[0]["function"].(map[string]any)
	arguments, ok := function["arguments"].(map[string]any)
	if !ok || arguments["filePath"] != "README.md" {
		t.Fatalf("tool arguments were not decoded for Ollama: %#v", function["arguments"])
	}
	if messages[2]["tool_name"] != "read" {
		t.Fatalf("tool result was not associated with its function: %#v", messages[2])
	}
	if _, exists := messages[2]["tool_call_id"]; exists {
		t.Fatalf("OpenAI-only tool_call_id leaked into Ollama history: %#v", messages[2])
	}
}

func TestOllamaClientActivatesConfiguredModel(t *testing.T) {
	var got struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/generate" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"done": true})
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Protocol: ProtocolOllama, BaseURL: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.ActivateModel(context.Background(), "selected-model"); err != nil {
		t.Fatal(err)
	}
	if got.Model != "selected-model" || got.Stream {
		t.Fatalf("unexpected activation request: %#v", got)
	}
}

func TestListModelsNormalizesVLLMAndOllamaPayloads(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{
				map[string]any{"id": "alpha", "max_model_len": 98304},
				map[string]any{"id": "beta", "max_model_len": 32768},
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
	if models[0].ContextLength != 98304 {
		t.Fatalf("unexpected context length: %#v", models[0])
	}
	contextLength, err := client.ContextLength(context.Background(), "beta")
	if err != nil {
		t.Fatal(err)
	}
	if contextLength != 32768 {
		t.Fatalf("got context length %d", contextLength)
	}
}

func TestOllamaClientContextLengthUsesModelMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/show" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		var input map[string]any
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		if input["model"] != "gemma3" {
			t.Fatalf("unexpected model %#v", input["model"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model_info": map[string]any{
				"gemma3.context_length": 131072,
				"gemma3.block_count":    34,
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Protocol: ProtocolOllama, BaseURL: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	contextLength, err := client.ContextLength(context.Background(), "gemma3")
	if err != nil {
		t.Fatal(err)
	}
	if contextLength != 131072 {
		t.Fatalf("got context length %d", contextLength)
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

func TestProviderEndpointURLAvoidsDuplicateV1(t *testing.T) {
	got, err := providerEndpointURL("http://example.test/v1", "", "v1/chat/completions")
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
		Model:           "model-a",
		Messages:        []Message{{Role: "user", Content: "hello"}},
		Stream:          true,
		Tools:           []any{map[string]any{"type": "function"}},
		ToolChoice:      "auto",
		MaxOutputTokens: 2048,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	streamOptions, _ := got["stream_options"].(map[string]any)
	if got["model"] != "model-a" || got["stream"] != true || got["tools"] == nil || got["tool_choice"] != "auto" || streamOptions["include_usage"] != true || got["max_tokens"] != float64(2048) {
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
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,YWJj"}},
				map[string]any{"type": "text", "text": "second"},
			},
		}},
		Stream:          false,
		Tools:           []any{map[string]any{"type": "function"}},
		ToolChoice:      "auto",
		MaxOutputTokens: 1024,
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
	images, ok := first["images"].([]any)
	if !ok || len(images) != 1 || images[0] != "YWJj" {
		t.Fatalf("Ollama image content was not forwarded: %#v", first)
	}
	options, _ := got["options"].(map[string]any)
	if options["num_predict"] != float64(1024) {
		t.Fatalf("Ollama output allowance was not enforced: %#v", got)
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
		`{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1234,"eval_count":56}`,
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
	if !strings.Contains(body, `"prompt_tokens":1234`) || !strings.Contains(body, `"completion_tokens":56`) || !strings.Contains(body, `"total_tokens":1290`) {
		t.Fatalf("missing converted usage: %q", body)
	}
	if !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("missing done marker: %q", body)
	}
}

func TestWriteOpenAIChatSSERejectsTruncatedOllamaStream(t *testing.T) {
	err := WriteOpenAIChatSSE(ProtocolOllama, &bytes.Buffer{}, strings.NewReader(`{"message":{"role":"assistant","content":"partial"},"done":false}`+"\n"))
	if err == nil {
		t.Fatal("expected truncated stream error")
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
