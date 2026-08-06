package model

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
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
		Mode:    ModeServer,
		BaseURL: server.URL,
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
		Think    *bool     `json:"think"`
		Format   any       `json:"format"`
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
		Mode:          ModeLocal,
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
	// Ordinary chat leaves thinking and output format alone.
	if got.Think != nil || got.Format != nil {
		t.Fatalf("plain chat must not constrain thinking or format: %#v", got)
	}

	// A classify-style request must disable thinking and grammar-constrain the
	// reply: thinking-by-default models otherwise return an empty content.
	if _, err := client.Chat(context.Background(), ChatRequest{
		Model:           "llama3",
		Messages:        []Message{{Role: "user", Content: "classify"}},
		DisableThinking: true,
		ResponseSchema:  map[string]any{"type": "object"},
	}); err != nil {
		t.Fatal(err)
	}
	if got.Think == nil || *got.Think {
		t.Fatalf("classify chat must send think=false: %#v", got)
	}
	if format, ok := got.Format.(map[string]any); !ok || format["type"] != "object" {
		t.Fatalf("classify chat must send the response schema as format: %#v", got.Format)
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
					"arguments": `{"path":"README.md"}`,
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
	if !ok || arguments["path"] != "README.md" {
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

	client, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: server.URL, Timeout: time.Second})
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

	client, err := NewClient(ClientConfig{Mode: ModeServer, BaseURL: server.URL, Timeout: time.Second})
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

func TestParseRuntimeMetricsSupportsPrometheusNameVariants(t *testing.T) {
	metrics, err := parseRuntimeMetrics(strings.NewReader(`
vllm:prefix_cache_hits_total{model_name="a"} 75
vllm_prefix_cache_queries_total{model_name="a"} 100
vllm:num_requests_waiting{model_name="a"} 4
`))
	if err != nil {
		t.Fatal(err)
	}
	if !metrics.Available || metrics.PrefixCacheHitRate != 0.75 || metrics.QueueDepth != 4 {
		t.Fatalf("unexpected metrics: %#v", metrics)
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

	client, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: server.URL, Timeout: time.Second})
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

func TestParseModeValues(t *testing.T) {
	cases := map[string]Mode{
		"server": ModeServer,
		"local":  ModeLocal,
	}
	for input, want := range cases {
		got, err := ParseMode(input)
		if err != nil {
			t.Fatalf("%q returned error: %v", input, err)
		}
		if got != want {
			t.Fatalf("%q got %q, want %q", input, got, want)
		}
	}
	for _, input := range []string{"", "vllm", "ollama", "raw"} {
		if _, err := ParseMode(input); err == nil {
			t.Fatalf("expected unsupported mode error for %q", input)
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
	if _, err := NewClient(ClientConfig{Mode: Mode("raw"), BaseURL: "http://provider.test"}); err == nil {
		t.Fatal("expected unsupported mode rejection")
	}
	if _, err := providerEndpointURL("", "", "v1/chat/completions"); err == nil {
		t.Fatal("expected missing base URL rejection")
	}
	if _, err := providerEndpointURL("http://base.test", "https://", "v1/chat/completions"); err == nil {
		t.Fatal("expected malformed endpoint URL rejection")
	}
}

func TestHardenedHTTPClientHasDeliberateSharedRuntimePoolLimits(t *testing.T) {
	client := hardenedHTTPClient(time.Minute)
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("unexpected transport type %T", client.Transport)
	}
	if transport.MaxIdleConns != 256 || transport.MaxIdleConnsPerHost != 128 || transport.MaxConnsPerHost != 256 {
		t.Fatalf("unexpected pool limits: %#v", transport)
	}
	if transport.IdleConnTimeout != 90*time.Second {
		t.Fatalf("unexpected idle timeout: %s", transport.IdleConnTimeout)
	}
}

func TestVLLMDoChatForwardsToolsAndGenerationProfile(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
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
		Mode:    ModeServer,
		BaseURL: server.URL,
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	budget := 512
	resp, err := client.DoChat(context.Background(), ChatRequest{
		Model:               "model-a",
		Messages:            []Message{{Role: "user", Content: "hello"}},
		Stream:              true,
		Tools:               []any{map[string]any{"type": "function"}},
		ToolChoice:          "auto",
		ParallelTools:       true,
		MaxOutputTokens:     2048,
		Temperature:         0.2,
		TopP:                0.95,
		ReasoningEffort:     ReasoningLow,
		ThinkingTokenBudget: &budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	streamOptions, _ := got["stream_options"].(map[string]any)
	if got["model"] != "model-a" || got["stream"] != true || got["tools"] == nil || got["tool_choice"] != "auto" ||
		got["parallel_tool_calls"] != true || streamOptions["include_usage"] != true || got["max_tokens"] != float64(2048) ||
		got["temperature"] != 0.2 || got["top_p"] != 0.95 || got["reasoning_effort"] != "low" || got["thinking_budget"] != float64(512) {
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

	client, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: server.URL, Timeout: time.Second})
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

	client, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: server.URL, Timeout: time.Second})
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
		`{"message":{"role":"assistant","content":"hi","tool_calls":[{"function":{"name":"read","arguments":{"path":"README.md"}}},{"function":{"name":"grep","arguments":{"pattern":"main","mode":"literal","path":"."}}}]},"done":false}`,
		`{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read","arguments":{"path":"README.md"}}},{"function":{"name":"grep","arguments":{"pattern":"main","mode":"literal","path":"."}}}]},"done":false}`,
		`{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read","arguments":{"path":"README.md"}}},{"function":{"name":"grep","arguments":{"pattern":"main","mode":"literal","path":"."}}}]},"done":true,"prompt_eval_count":1234,"eval_count":56}`,
		"",
	}, "\n"))
	var dst bytes.Buffer
	if err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &dst, src, time.Second, UsageAnnotation{}); err != nil {
		t.Fatal(err)
	}
	body := dst.String()
	if !strings.Contains(body, `"role":"assistant"`) || !strings.Contains(body, `"content":"hi"`) {
		t.Fatalf("missing assistant delta: %q", body)
	}
	if !strings.Contains(body, `"name":"read"`) || !strings.Contains(body, `"{\"path\":\"README.md\"}"`) {
		t.Fatalf("missing converted tool call: %q", body)
	}
	if !strings.Contains(body, `"name":"grep"`) || !strings.Contains(body, `"index":1`) {
		t.Fatalf("missing parallel tool call indexes: %q", body)
	}
	toolMarker := `"tool_calls"`
	firstTools := strings.Index(body, toolMarker)
	doneMarker := strings.Index(body, "data: [DONE]")
	if firstTools < 0 || doneMarker < 0 || firstTools > doneMarker {
		t.Fatalf("tool calls must be emitted before the completion marker: %q", body)
	}
	if strings.Count(body, `"name":"read"`) != 1 || strings.Count(body, `"name":"grep"`) != 1 {
		t.Fatalf("Ollama tool calls were repeated across stream chunks: %q", body)
	}
	if !strings.Contains(body, `"prompt_tokens":1234`) || !strings.Contains(body, `"completion_tokens":56`) || !strings.Contains(body, `"total_tokens":1290`) {
		t.Fatalf("missing converted usage: %q", body)
	}
	if !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("missing done marker: %q", body)
	}
}

func TestWriteOpenAIChatSSEStripsPrivateReasoningFromVLLM(t *testing.T) {
	src := strings.NewReader(strings.Join([]string{
		`data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"hidden plan"}}]}`,
		`data: {"choices":[{"delta":{"content":"Safe progress.","thinking":"hidden thought"}}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n"))
	var dst bytes.Buffer
	if err := WriteOpenAIChatSSE(context.Background(), ModeServer, &dst, src, time.Second, UsageAnnotation{}); err != nil {
		t.Fatal(err)
	}
	body := dst.String()
	if strings.Contains(body, "hidden plan") || strings.Contains(body, "hidden thought") || strings.Contains(body, "reasoning_content") || strings.Contains(body, `"thinking"`) {
		t.Fatalf("private reasoning leaked through: %q", body)
	}
	if !strings.Contains(body, `"content":"Safe progress."`) || !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("safe content or completion marker was lost: %q", body)
	}
}

func TestWriteOpenAIChatSSERejectsUnsafeVLLMStreams(t *testing.T) {
	for name, stream := range map[string]string{
		"missing completion": `data: {"choices":[{"delta":{"content":"partial"}}]}` + "\n\n",
		"oversized line":     "data: " + strings.Repeat("x", 4*1024*1024+1) + "\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			if err := WriteOpenAIChatSSE(context.Background(), ModeServer, &bytes.Buffer{}, strings.NewReader(stream), time.Second, UsageAnnotation{}); err == nil {
				t.Fatal("expected invalid stream error")
			}
		})
	}
}

func TestWriteOpenAIChatSSERejectsTruncatedOllamaStream(t *testing.T) {
	err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &bytes.Buffer{}, strings.NewReader(`{"message":{"role":"assistant","content":"partial"},"done":false}`+"\n"), time.Second, UsageAnnotation{})
	if err == nil {
		t.Fatal("expected truncated stream error")
	}
}

func TestWriteOpenAIChatSSERejectsNonAssistantOllamaMessages(t *testing.T) {
	err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &bytes.Buffer{}, strings.NewReader(`{"message":{"role":"user","content":"bad"},"done":false}`), time.Second, UsageAnnotation{})
	if err == nil {
		t.Fatal("expected non-assistant message error")
	}
}

func TestWriteOpenAIChatSSERejectsUnsupportedMode(t *testing.T) {
	err := WriteOpenAIChatSSE(context.Background(), Mode("raw"), &bytes.Buffer{}, strings.NewReader(""), time.Second, UsageAnnotation{})
	if err == nil {
		t.Fatal("expected unsupported mode error")
	}
}

func TestAllowedProviderIP(t *testing.T) {
	for _, test := range []struct {
		ip   string
		want bool
	}{
		{"127.0.0.1", true},
		{"::1", true},
		{"10.0.0.4", true},
		{"192.168.1.4", true},
		{"169.254.169.254", false},
		{"8.8.8.8", false},
		{"0.0.0.0", false},
	} {
		if got := allowedProviderIP(net.ParseIP(test.ip)); got != test.want {
			t.Errorf("allowedProviderIP(%s)=%v want %v", test.ip, got, test.want)
		}
	}
}

func TestHardenedTransportRejectsRedirectsAndIgnoresProxy(t *testing.T) {
	redirects := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirects++
		http.Redirect(w, r, "/final", http.StatusFound)
	}))
	defer server.Close()

	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9")
	t.Setenv("ALL_PROXY", "http://127.0.0.1:9")
	t.Setenv("http_proxy", "http://127.0.0.1:9")

	client, err := NewClient(ClientConfig{
		Mode:    ModeLocal,
		BaseURL: server.URL,
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListModels(context.Background())
	if err == nil {
		t.Fatal("expected redirect rejection")
	}
	if redirects != 1 {
		t.Fatalf("expected exactly one redirect response without following, got %d (err=%v)", redirects, err)
	}
}

func TestHardenedTransportRejectsPublicProviderIP(t *testing.T) {
	client := hardenedHTTPClient(time.Second)
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://8.8.8.8/", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Do(request)
	if err == nil {
		t.Fatal("expected public IP rejection")
	}
	if !strings.Contains(err.Error(), "loopback or private") && !strings.Contains(err.Error(), "disallowed") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVLLMRequestsMarkFunctionsStrict(t *testing.T) {
	// The runner sends the canonical three-key function; strict mode is a vLLM
	// detail applied at the boundary.
	tools := []any{map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        "read",
			"description": "Read one file.",
			"parameters":  map[string]any{"type": "object"},
		},
	}}
	marked, ok := strictTools(tools).([]any)
	if !ok || len(marked) != 1 {
		t.Fatalf("unexpected tools shape: %#v", marked)
	}
	function := marked[0].(map[string]any)["function"].(map[string]any)
	if function["strict"] != true {
		t.Fatalf("vLLM functions must be strict: %#v", function)
	}
	// The caller's value is left alone; only the outgoing request is changed.
	original := tools[0].(map[string]any)["function"].(map[string]any)
	if _, added := original["strict"]; added {
		t.Fatal("strictTools mutated the caller's tool contract")
	}
}

func TestUsageFramesCarryTheProtectedPrefixSize(t *testing.T) {
	annotation := UsageAnnotation{SystemPromptTokens: 3187, Exact: true}

	var vllm bytes.Buffer
	vllmStream := strings.NewReader(strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"answer"}}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":41230,"completion_tokens":512,"total_tokens":41742}}`,
		`data: [DONE]`,
		"",
	}, "\n\n"))
	if err := WriteOpenAIChatSSE(context.Background(), ModeServer, &vllm, vllmStream, time.Second, annotation); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(vllm.String(), `"system_prompt_tokens":3187`) {
		t.Fatalf("vLLM usage frame lost the prefix size: %q", vllm.String())
	}
	if !strings.Contains(vllm.String(), `"system_prompt_tokens_exact":true`) {
		t.Fatalf("vLLM usage frame lost the exactness flag: %q", vllm.String())
	}
	if strings.Count(vllm.String(), `"system_prompt_tokens"`) != 1 {
		t.Fatalf("the prefix size belongs only on the usage frame: %q", vllm.String())
	}

	// Ollama has no tokenize endpoint, so its size is a flagged estimate.
	var ollama bytes.Buffer
	ollamaStream := strings.NewReader(
		`{"message":{"role":"assistant","content":"answer"},"done":true,"prompt_eval_count":1234,"eval_count":56}` + "\n",
	)
	estimated := UsageAnnotation{SystemPromptTokens: 812}
	if err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &ollama, ollamaStream, time.Second, estimated); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ollama.String(), `"system_prompt_tokens":812`) {
		t.Fatalf("Ollama usage frame lost the prefix size: %q", ollama.String())
	}
	if !strings.Contains(ollama.String(), `"system_prompt_tokens_exact":false`) {
		t.Fatalf("an estimated Ollama size must not claim to be exact: %q", ollama.String())
	}

	// Without a size, nothing is added and the frame stays exactly as before.
	var bare bytes.Buffer
	bareStream := strings.NewReader(
		`{"message":{"role":"assistant","content":"answer"},"done":true,"prompt_eval_count":10,"eval_count":2}` + "\n",
	)
	if err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &bare, bareStream, time.Second, UsageAnnotation{}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(bare.String(), "system_prompt_tokens") {
		t.Fatalf("an unknown prefix size must not be reported as zero: %q", bare.String())
	}
}

func TestPrefixTokensCountsOncePerDistinctPrefix(t *testing.T) {
	counts := 0
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/tokenize" {
			t.Errorf("unexpected tokenize path %q", r.URL.Path)
		}
		counts++
		_, _ = io.WriteString(w, `{"count":3187}`)
	}))
	defer runtime.Close()

	client, err := NewClient(ClientConfig{Mode: ModeServer, BaseURL: runtime.URL})
	if err != nil {
		t.Fatal(err)
	}
	prefix := []Message{{Role: "system", Content: "protected prompt"}}
	for range 2 {
		annotation := client.PrefixTokens(context.Background(), "engineering:a", "model", prefix)
		if annotation.SystemPromptTokens != 3187 || !annotation.Exact {
			t.Fatalf("unexpected annotation %+v", annotation)
		}
	}
	if counts != 1 {
		t.Fatalf("a repeated prefix must be counted once, got %d calls", counts)
	}

	// A different catalog is a different key, so it is recounted.
	client.PrefixTokens(context.Background(), "engineering:b", "model", prefix)
	if counts != 2 {
		t.Fatalf("a changed prefix must be recounted, got %d calls", counts)
	}
}

func TestPrefixTokensFallsBackToAFlaggedEstimate(t *testing.T) {
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer runtime.Close()

	client, err := NewClient(ClientConfig{Mode: ModeServer, BaseURL: runtime.URL})
	if err != nil {
		t.Fatal(err)
	}
	prefix := []Message{{Role: "system", Content: strings.Repeat("x", 400)}}
	annotation := client.PrefixTokens(context.Background(), "engineering:a", "model", prefix)
	if annotation.Exact {
		t.Fatal("a runtime that cannot tokenize must not yield an exact count")
	}
	if annotation.SystemPromptTokens != 101 {
		t.Fatalf("unexpected fallback estimate %d", annotation.SystemPromptTokens)
	}

	local, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: runtime.URL})
	if err != nil {
		t.Fatal(err)
	}
	if local.PrefixTokens(context.Background(), "engineering:a", "model", prefix).Exact {
		t.Fatal("the local runtime has no tokenize endpoint to be exact with")
	}
}
