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
			t.Fatalf("an unconfigured API key must not produce an authorization header")
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

func TestLocalClientChatSpeaksOpenAIWithABearer(t *testing.T) {
	var got map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer local-secret" {
			t.Fatalf("local runtime call must carry the per-run bearer: %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{
				map[string]any{"message": map[string]string{"role": "assistant", "content": "local done"}},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{
		Mode:          ModeLocal,
		BaseURL:       server.URL,
		ContextLength: 64000,
		APIKey:        "local-secret",
		Timeout:       time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := client.Chat(context.Background(), ChatRequest{
		Model:    "qwen3-8b",
		Messages: []Message{{Role: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["model"] != "qwen3-8b" || got["stream"] != false {
		t.Fatalf("unexpected runtime request: %#v", got)
	}
	if resp.Message.Content != "local done" {
		t.Fatalf("unexpected response: %#v", resp)
	}
	// Ordinary chat leaves thinking and output shape alone.
	if _, present := got["chat_template_kwargs"]; present {
		t.Fatalf("plain chat must not constrain thinking: %#v", got)
	}
	if _, present := got["response_format"]; present {
		t.Fatalf("plain chat must not constrain the response shape: %#v", got)
	}

	// A classify-style request grammar-constrains the reply but never touches
	// the model's thinking: the model decides how much to reason, and the
	// schema means the content it returns can only be the decision shape.
	if _, err := client.Chat(context.Background(), ChatRequest{
		Model:          "qwen3-8b",
		Messages:       []Message{{Role: "user", Content: "classify"}},
		ResponseSchema: map[string]any{"type": "object"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, present := got["chat_template_kwargs"]; present {
		t.Fatalf("the thinking default must be left to the model: %#v", got)
	}
	format, _ := got["response_format"].(map[string]any)
	schema, _ := format["json_schema"].(map[string]any)
	constraint, _ := schema["schema"].(map[string]any)
	if format["type"] != "json_schema" || constraint["type"] != "object" {
		t.Fatalf("classify chat must send the response schema as response_format: %#v", got["response_format"])
	}
}

// A shared vLLM fleet is not Veil's to grammar-constrain per request, so the
// same ChatRequest field is deliberately inert on the server path.
func TestServerChatIgnoresTheResponseSchema(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"role": "assistant", "content": "ok"}}},
		})
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Mode: ModeServer, BaseURL: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Chat(context.Background(), ChatRequest{
		Model:          "fleet",
		Messages:       []Message{{Role: "user", Content: "classify"}},
		ResponseSchema: map[string]any{"type": "object"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, present := got["response_format"]; present {
		t.Fatalf("the server path must not constrain a shared fleet: %#v", got)
	}
}

// llama-server loads its weights at process start, so there is nothing to warm.
// Activation is only a question — is the process on that port up, and does it
// accept our bearer — which is exactly one authenticated GET /v1/models.
func TestLocalActivateModelIsAnAuthenticatedReadinessCheck(t *testing.T) {
	paths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer local-secret" {
			t.Errorf("readiness check must be authenticated: %q", r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"id": "selected-model"}}})
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: server.URL, APIKey: "local-secret", Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.ActivateModel(context.Background(), "selected-model"); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || paths[0] != "GET /v1/models" {
		t.Fatalf("unexpected activation traffic: %#v", paths)
	}
}

func TestLocalActivateModelFailsWhenTheRuntimeRefuses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.ActivateModel(context.Background(), "selected-model"); err == nil {
		t.Fatal("a runtime that refuses the bearer must not read as activated")
	}
}

func TestListModelsNormalizesOpenAIPayloads(t *testing.T) {
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

// The desktop starts llama-server with exactly the configured --ctx-size, so
// configuration is ground truth and the runtime is never asked.
func TestLocalContextLengthComesFromConfiguration(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the local context length must not cost a runtime call: %s", r.URL.Path)
		http.NotFound(w, r)
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: server.URL, ContextLength: 131072, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	contextLength, err := client.ContextLength(context.Background(), "qwen3-8b")
	if err != nil {
		t.Fatal(err)
	}
	if contextLength != 131072 {
		t.Fatalf("got context length %d", contextLength)
	}

	unconfigured, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := unconfigured.ContextLength(context.Background(), "qwen3-8b"); err == nil {
		t.Fatal("an unconfigured local context length must be an error, not a guess")
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

// Multimodal content parts travel to the local runtime as the OpenAI array
// they arrived as: llama-server reads them directly, so nothing is flattened
// and no image is moved into a side channel.
func TestLocalDoChatForwardsOpenAIContentPartsAndToolChoice(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{Mode: ModeLocal, BaseURL: server.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.DoChat(context.Background(), ChatRequest{
		Model: "qwen3-8b",
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
		ParallelTools:   true,
		MaxOutputTokens: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	messages := got["messages"].([]any)
	parts, ok := messages[0].(map[string]any)["content"].([]any)
	if !ok || len(parts) != 3 {
		t.Fatalf("content parts were not forwarded intact: %#v", messages[0])
	}
	image, _ := parts[1].(map[string]any)["image_url"].(map[string]any)
	if image["url"] != "data:image/png;base64,YWJj" {
		t.Fatalf("image content was not forwarded intact: %#v", parts[1])
	}
	if got["max_tokens"] != float64(1024) {
		t.Fatalf("output allowance was not enforced: %#v", got)
	}
	if got["tool_choice"] != "auto" || got["parallel_tool_calls"] != true || got["tools"] == nil {
		t.Fatalf("tool contract was not forwarded: %#v", got)
	}
}

// Some OpenAI-compatible runtimes answer /v1/models with `models` rather than
// `data`, and repeat an id across shapes. The normalizer takes both and dedupes.
func TestListModelsNormalizesAlternatePayloadsAndDedupes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"models": []any{
				map[string]string{"name": "qwen3-8b"},
				map[string]string{"model": "gemma"},
				"qwen3-8b",
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
	if len(models) != 3 || models[0].ID != "qwen3-8b" || models[1].ID != "gemma" || models[2].ID != "mistral" {
		t.Fatalf("unexpected models: %#v", models)
	}
}

// llama-server's template parser emits structured tool_calls deltas for the
// Qwen family. Veil must forward them byte for byte: rebuilding them is what
// used to renumber parallel calls onto one index.
func TestWriteOpenAIChatSSEPassesLocalToolCallsThrough(t *testing.T) {
	src := strings.NewReader(strings.Join([]string{
		`data: {"choices":[{"delta":{"role":"assistant","content":"hi"}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{\"path\":\"README.md\"}"}},{"index":1,"id":"call-2","type":"function","function":{"name":"grep","arguments":"{\"pattern\":\"main\"}"}}]}}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":56,"total_tokens":1290}}`,
		`data: [DONE]`,
		"",
	}, "\n\n"))
	var dst bytes.Buffer
	if err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &dst, src, time.Second, UsageAnnotation{}, false); err != nil {
		t.Fatal(err)
	}
	body := dst.String()
	if !strings.Contains(body, `"role":"assistant"`) || !strings.Contains(body, `"content":"hi"`) {
		t.Fatalf("missing assistant delta: %q", body)
	}
	if !strings.Contains(body, `"name":"read"`) || !strings.Contains(body, `"{\"path\":\"README.md\"}"`) {
		t.Fatalf("missing forwarded tool call: %q", body)
	}
	if !strings.Contains(body, `"name":"grep"`) || !strings.Contains(body, `"index":1`) {
		t.Fatalf("parallel tool call indexes were not preserved: %q", body)
	}
	firstTools := strings.Index(body, `"tool_calls"`)
	doneMarker := strings.Index(body, "data: [DONE]")
	if firstTools < 0 || doneMarker < 0 || firstTools > doneMarker {
		t.Fatalf("tool calls must be emitted before the completion marker: %q", body)
	}
	if strings.Count(body, `"name":"read"`) != 1 || strings.Count(body, `"name":"grep"`) != 1 {
		t.Fatalf("tool calls were duplicated: %q", body)
	}
	if !strings.Contains(body, `"prompt_tokens":1234`) || !strings.Contains(body, `"total_tokens":1290`) {
		t.Fatalf("missing usage: %q", body)
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
	if err := WriteOpenAIChatSSE(context.Background(), ModeServer, &dst, src, time.Second, UsageAnnotation{}, false); err != nil {
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

func TestWriteOpenAIChatSSEForwardsReasoningWhenAsked(t *testing.T) {
	src := strings.NewReader(strings.Join([]string{
		`data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"shown plan"}}]}`,
		`data: {"choices":[{"delta":{"content":"Safe progress.","thinking":"shown thought"}}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n"))
	var dst bytes.Buffer
	if err := WriteOpenAIChatSSE(context.Background(), ModeServer, &dst, src, time.Second, UsageAnnotation{}, true); err != nil {
		t.Fatal(err)
	}
	body := dst.String()
	if !strings.Contains(body, "shown plan") || !strings.Contains(body, "shown thought") {
		t.Fatalf("opted-in reasoning was stripped: %q", body)
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
			if err := WriteOpenAIChatSSE(context.Background(), ModeServer, &bytes.Buffer{}, strings.NewReader(stream), time.Second, UsageAnnotation{}, false); err == nil {
				t.Fatal("expected invalid stream error")
			}
		})
	}
}

func TestWriteOpenAIChatSSERejectsUnsafeLocalStreams(t *testing.T) {
	for name, stream := range map[string]string{
		"missing completion":     `data: {"choices":[{"delta":{"content":"partial"}}]}` + "\n\n",
		"not server-sent events": `{"message":{"role":"assistant","content":"partial"},"done":false}` + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			if err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &bytes.Buffer{}, strings.NewReader(stream), time.Second, UsageAnnotation{}, false); err == nil {
				t.Fatal("expected invalid stream error")
			}
		})
	}
}

func TestWriteOpenAIChatSSEStripsPrivateReasoningFromTheLocalRuntime(t *testing.T) {
	src := strings.NewReader(strings.Join([]string{
		`data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"hidden plan"}}]}`,
		`data: {"choices":[{"delta":{"content":"Safe progress."}}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n"))
	var dst bytes.Buffer
	if err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &dst, src, time.Second, UsageAnnotation{}, false); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(dst.String(), "hidden plan") || strings.Contains(dst.String(), "reasoning_content") {
		t.Fatalf("private reasoning leaked through the local path: %q", dst.String())
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
	if err := WriteOpenAIChatSSE(context.Background(), ModeServer, &vllm, vllmStream, time.Second, annotation, false); err != nil {
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

	// A tokenize call that did not answer leaves a flagged estimate, which must
	// travel as an estimate rather than as a measurement.
	var local bytes.Buffer
	localStream := strings.NewReader(strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"answer"}}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":56,"total_tokens":1290}}`,
		`data: [DONE]`,
		"",
	}, "\n\n"))
	estimated := UsageAnnotation{SystemPromptTokens: 812}
	if err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &local, localStream, time.Second, estimated, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(local.String(), `"system_prompt_tokens":812`) {
		t.Fatalf("local usage frame lost the prefix size: %q", local.String())
	}
	if !strings.Contains(local.String(), `"system_prompt_tokens_exact":false`) {
		t.Fatalf("an estimated size must not claim to be exact: %q", local.String())
	}

	// Without a size, nothing is added and the frame stays exactly as before.
	var bare bytes.Buffer
	bareStream := strings.NewReader(strings.Join([]string{
		`data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`,
		`data: [DONE]`,
		"",
	}, "\n\n"))
	if err := WriteOpenAIChatSSE(context.Background(), ModeLocal, &bare, bareStream, time.Second, UsageAnnotation{}, false); err != nil {
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
		t.Fatal("a local runtime that will not tokenize must not yield an exact count either")
	}
}

// Both runtimes answer /tokenize with a token array, and both reject the
// other's request body, so the shape has to follow the mode.
func TestTokenizeRequestShapeFollowsTheMode(t *testing.T) {
	for _, test := range []struct {
		name string
		mode Mode
		// what the stub answers with, and what the request must look like
		reply  string
		verify func(t *testing.T, body map[string]any)
		want   int
	}{
		{
			name:  "server sends the chat shape and reads count",
			mode:  ModeServer,
			reply: `{"count":3187,"tokens":[1,2,3]}`,
			want:  3187,
			verify: func(t *testing.T, body map[string]any) {
				if body["model"] != "model" || body["messages"] == nil {
					t.Fatalf("vLLM tokenize needs the model and the chat messages: %#v", body)
				}
				if _, present := body["content"]; present {
					t.Fatalf("vLLM tokenize must not be sent a content string: %#v", body)
				}
			},
		},
		{
			name:  "local sends one content string and counts the tokens",
			mode:  ModeLocal,
			reply: `{"tokens":[1,2,3,4]}`,
			want:  4,
			verify: func(t *testing.T, body map[string]any) {
				if body["content"] != "protected prompt\n" {
					t.Fatalf("llama-server tokenize needs the prefix as one string: %#v", body)
				}
				if _, present := body["messages"]; present {
					t.Fatalf("llama-server tokenize must not be sent chat messages: %#v", body)
				}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var body map[string]any
			runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/tokenize" {
					t.Errorf("unexpected tokenize path %q", r.URL.Path)
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				_, _ = io.WriteString(w, test.reply)
			}))
			defer runtime.Close()

			client, err := NewClient(ClientConfig{Mode: test.mode, BaseURL: runtime.URL})
			if err != nil {
				t.Fatal(err)
			}
			annotation := client.PrefixTokens(
				context.Background(), "engineering:a", "model",
				[]Message{{Role: "system", Content: "protected prompt"}},
			)
			if !annotation.Exact || annotation.SystemPromptTokens != test.want {
				t.Fatalf("unexpected annotation %+v", annotation)
			}
			test.verify(t, body)
		})
	}
}
