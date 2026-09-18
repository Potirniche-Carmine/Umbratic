package model

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Message struct {
	Role       string `json:"role"`
	Content    any    `json:"content"`
	ToolCallID string `json:"tool_call_id,omitempty"`
	ToolCalls  any    `json:"tool_calls,omitempty"`
}

type ChatRequest struct {
	SamplingProfile *SamplingProfile
	Model           string
	Messages        []Message
	Stream          bool
	Tools           any
	ToolChoice      any
	ParallelTools   bool
	MaxOutputTokens int
	Temperature     float64
	TopP            float64
	// The truncation and penalty samplers. Each is omitted from the request
	// when zero, which is also each one's no-op value.
	TopK                int
	MinP                float64
	PresencePenalty     float64
	RepetitionPenalty   float64
	ReasoningEffort     ReasoningEffort
	ThinkingTokenBudget *int
	// Thinking forces the model to reason, or not to, for this request. nil
	// leaves the runtime on its own default. It controls whether the model
	// thinks, not whether that thinking is shown.
	Thinking *bool
	// ReasoningVisible forwards reasoning tokens on the stream. False (the
	// default) keeps stripPrivateReasoning. The HTTP layer only sets this when
	// the client sent reasoning_visible after Veil advertised the feature.
	ReasoningVisible bool
	// ResponseSchema constrains local generation to this JSON schema through
	// the runtime's grammar-backed structured outputs. nil leaves generation
	// unconstrained. Local mode only; the server path ignores it, because a
	// shared vLLM fleet is not Veil's to constrain per request.
	ResponseSchema map[string]any
}

type ChatResponse struct {
	Message Message
}

type ModelInfo struct {
	ID            string `json:"id"`
	ContextLength int    `json:"context_length,omitempty"`
}

type ClientConfig struct {
	Mode          Mode
	BaseURL       string
	ContextLength int
	Timeout       time.Duration
	// APIKey is sent as a bearer on every runtime call. Local mode always has
	// one: the desktop mints a per-run secret so a second process on the box
	// cannot drive the model runtime it started.
	APIKey string
	// EmbeddingBaseURL points at the runtime that serves `/v1/embeddings`. It
	// is a second instance rather than the chat one, because a vLLM process
	// serves exactly one model. Empty means retrieval is not configured, and
	// Embed refuses rather than guessing an endpoint.
	EmbeddingBaseURL string
	EmbeddingModel   string
}

type Client struct {
	mode             Mode
	chatEndpoint     string
	modelsEndpoint   string
	metricsEndpoint  string
	tokenizeEndpoint string
	embedEndpoint    string
	embedModel       string
	apiKey           string
	contextLength    int
	client           *http.Client
	prefixTokens     prefixTokenCache
}

type ProviderError struct {
	StatusCode int
	Kind       ProviderFailureKind
	// Cause is the underlying transport error — Go http client text such as
	// "dial tcp 127.0.0.1:11434: connectex: No connection could be made", never
	// model output. Without it, every runtime outage reads as the same
	// "model runtime request failed", which proved undebuggable in a live run.
	Cause error
}

type ProviderFailureKind string

const (
	ProviderFailureTransport       ProviderFailureKind = "transport"
	ProviderFailureTimeout         ProviderFailureKind = "timeout"
	ProviderFailureStatus          ProviderFailureKind = "status"
	ProviderFailureInvalidResponse ProviderFailureKind = "invalid_response"
)

func (e ProviderError) Error() string {
	base := fmt.Sprintf("model runtime returned status %d", e.StatusCode)
	if e.StatusCode == 0 {
		base = "model runtime request failed"
		if e.Kind == ProviderFailureTimeout {
			base = "model runtime request timed out"
		}
	}
	if e.Cause != nil {
		return base + ": " + e.Cause.Error()
	}
	return base
}

func (e ProviderError) Unwrap() error { return e.Cause }

func NewClient(cfg ClientConfig) (*Client, error) {
	mode := cfg.Mode
	if mode != ModeServer && mode != ModeLocal {
		return nil, fmt.Errorf("unsupported Veil mode %q", mode)
	}

	// Both modes speak OpenAI now: vLLM on a company server, llama-server on
	// loopback. The mode still decides request shape in a few places, but no
	// longer which routes exist.
	chatEndpoint, err := providerEndpointURL(cfg.BaseURL, "", "v1/chat/completions")
	if err != nil {
		return nil, err
	}
	modelsEndpoint, err := providerEndpointURL(cfg.BaseURL, "", "v1/models")
	if err != nil {
		return nil, err
	}
	// OpenAI base URLs can end in /v1; runtime operations live outside it.
	runtimeBaseURL := strings.TrimSuffix(strings.TrimRight(cfg.BaseURL, "/"), "/v1")
	metricsEndpoint, err := providerEndpointURL(runtimeBaseURL, "", "metrics")
	if err != nil {
		return nil, err
	}
	// Both runtimes expose /tokenize at the server root; only the request body
	// differs, which tokenizePrefix branches on.
	tokenizeEndpoint, err := providerEndpointURL(runtimeBaseURL, "", "tokenize")
	if err != nil {
		return nil, err
	}

	embedEndpoint := ""
	if strings.TrimSpace(cfg.EmbeddingBaseURL) != "" {
		embedEndpoint, err = providerEndpointURL(cfg.EmbeddingBaseURL, "", "v1/embeddings")
		if err != nil {
			return nil, err
		}
	}

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 180 * time.Second
	}
	return &Client{
		mode:             mode,
		chatEndpoint:     chatEndpoint,
		modelsEndpoint:   modelsEndpoint,
		metricsEndpoint:  metricsEndpoint,
		tokenizeEndpoint: tokenizeEndpoint,
		embedEndpoint:    embedEndpoint,
		embedModel:       strings.TrimSpace(cfg.EmbeddingModel),
		apiKey:           strings.TrimSpace(cfg.APIKey),
		contextLength:    cfg.ContextLength,
		client:           hardenedHTTPClient(timeout),
	}, nil
}

// Embed returns one vector for one query string. It exists for retrieval, which
// runs inside a chat request under a short budget, so the caller's context
// deadline — not the client timeout — is what bounds it in practice.
func (c *Client) Embed(ctx context.Context, text string) ([]float32, error) {
	if c.embedEndpoint == "" || c.embedModel == "" {
		return nil, errors.New("no embedding runtime is configured")
	}
	resp, err := c.postJSON(ctx, c.embedEndpoint, map[string]any{
		"model": c.embedModel,
		"input": []string{text},
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, ProviderError{StatusCode: resp.StatusCode, Kind: ProviderFailureStatus}
	}
	var decoded struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&decoded); err != nil {
		return nil, ProviderError{Kind: ProviderFailureInvalidResponse}
	}
	if len(decoded.Data) == 0 || len(decoded.Data[0].Embedding) == 0 {
		return nil, ProviderError{Kind: ProviderFailureInvalidResponse}
	}
	return decoded.Data[0].Embedding, nil
}

// HardenedHTTPClient is the only client shape Veil uses for outbound calls to
// services on the box: no proxy, no redirects, and a dialer that refuses any
// address outside loopback and private ranges. Retrieval reuses it so the
// vector database is reached under exactly the same rules as the runtime.
func HardenedHTTPClient(timeout time.Duration) *http.Client {
	return hardenedHTTPClient(timeout)
}

func hardenedHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("provider redirects are not allowed")
		},
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           dialPrivateProvider,
			MaxIdleConns:          256,
			MaxIdleConnsPerHost:   128,
			MaxConnsPerHost:       256,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: timeout,
			ExpectContinueTimeout: 1 * time.Second,
			ForceAttemptHTTP2:     false,
		},
	}
}

func allowedProviderIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}

func dialPrivateProvider(ctx context.Context, network, destination string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(destination)
	if err != nil {
		return nil, errors.New("provider destination is invalid")
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	if ip := net.ParseIP(host); ip != nil {
		if !allowedProviderIP(ip) {
			return nil, errors.New("provider host must be a loopback or private address")
		}
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if dialErr != nil {
			return nil, dialErr
		}
		return ensurePrivateRemote(conn)
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("provider host could not be resolved")
	}
	var lastErr error
	for _, address := range addresses {
		if !allowedProviderIP(address.IP) {
			lastErr = errors.New("provider host must resolve only to loopback or private addresses")
			continue
		}
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
		if dialErr != nil {
			lastErr = dialErr
			continue
		}
		secured, secureErr := ensurePrivateRemote(conn)
		if secureErr != nil {
			lastErr = secureErr
			continue
		}
		return secured, nil
	}
	if lastErr == nil {
		lastErr = errors.New("provider host must resolve only to loopback or private addresses")
	}
	return nil, lastErr
}

func ensurePrivateRemote(conn net.Conn) (net.Conn, error) {
	remote, ok := conn.RemoteAddr().(*net.TCPAddr)
	if !ok || !allowedProviderIP(remote.IP) {
		_ = conn.Close()
		return nil, errors.New("provider connected to a disallowed address")
	}
	return conn, nil
}

// ActivateModel confirms the local runtime is up and answering as us.
//
// There is nothing to warm: llama-server loads its weights at process start and
// holds them for its lifetime, so the only question this can ask is whether the
// process on that port is ready and accepts our bearer. A server-mode fleet
// manages its own residency, so this is a no-op there.
func (c *Client) ActivateModel(ctx context.Context, modelID string) error {
	if c.mode != ModeLocal {
		return nil
	}
	if _, err := c.ListModels(ctx); err != nil {
		return err
	}
	return nil
}

func (c *Client) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	resp, err := c.DoChat(ctx, req)
	if err != nil {
		return ChatResponse{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return ChatResponse{}, ProviderError{StatusCode: resp.StatusCode, Kind: ProviderFailureStatus}
	}

	return decodeOpenAIChat(resp.Body)
}

func (c *Client) DoChat(ctx context.Context, req ChatRequest) (*http.Response, error) {
	return c.doOpenAIChat(ctx, req)
}

func WriteOpenAIChatSSE(ctx context.Context, mode Mode, dst io.Writer, src io.Reader, idleTimeout time.Duration, annotation UsageAnnotation, forwardReasoning bool) error {
	src = withIdleAndCancel(ctx, src, idleTimeout)
	return writeSafeOpenAIChatSSE(mode, dst, src, annotation, forwardReasoning)
}

func (c *Client) ListModels(ctx context.Context) ([]ModelInfo, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.modelsEndpoint, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(httpReq)

	resp, err := c.client.Do(httpReq)
	if err != nil {
		return nil, ProviderError{Kind: ProviderFailureTransport, Cause: err}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, ProviderError{StatusCode: resp.StatusCode, Kind: ProviderFailureStatus}
	}

	var payload any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return nil, ProviderError{Kind: ProviderFailureInvalidResponse}
	}

	return modelInfosFromPayload(payload), nil
}

func (c *Client) ContextLength(ctx context.Context, modelID string) (int, error) {
	if c.mode == ModeServer {
		models, err := c.ListModels(ctx)
		if err != nil {
			return 0, err
		}
		for _, available := range models {
			if available.ID == modelID && available.ContextLength > 0 {
				return available.ContextLength, nil
			}
		}
		return 0, errors.New("model runtime did not report a context length")
	}
	if c.mode != ModeLocal {
		return 0, fmt.Errorf("unsupported Veil mode %q", c.mode)
	}

	// Configuration is ground truth locally: the desktop starts llama-server
	// with exactly this --ctx-size, so asking the runtime could only ever
	// disagree with the launcher that set it.
	if c.contextLength <= 0 {
		return 0, errors.New("no local context length is configured")
	}
	return c.contextLength, nil
}

// mergeLeadingSystemMessages folds Veil's own system prefix — the global
// prompt, the route prompt, the skill catalog — into a single system message.
//
// Veil composes the prefix as separate messages because they change
// independently, but a chat template only ever sees the joined result, and
// several refuse anything else: Qwen-family templates that raise "System
// message must be at the beginning" on the second one, Gemma's that folds only
// the first into the user turn. One message is what every template accepts,
// and it renders to the same text on the ones that would have taken three.
// Only a leading run of string-content system messages is folded; anything
// else is left exactly as it was.
func mergeLeadingSystemMessages(messages []Message) []Message {
	var parts []string
	for _, message := range messages {
		content, ok := message.Content.(string)
		if message.Role != "system" || !ok {
			break
		}
		parts = append(parts, content)
	}
	if len(parts) < 2 {
		return messages
	}
	merged := make([]Message, 0, len(messages)-len(parts)+1)
	merged = append(merged, Message{Role: "system", Content: strings.Join(parts, "\n\n")})
	return append(merged, messages[len(parts):]...)
}

func (c *Client) doOpenAIChat(ctx context.Context, req ChatRequest) (*http.Response, error) {
	body := map[string]any{
		"model":       req.Model,
		"messages":    mergeLeadingSystemMessages(req.Messages),
		"stream":      req.Stream,
		"temperature": req.Temperature,
		"top_p":       req.TopP,
	}
	if req.Stream {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if req.MaxOutputTokens > 0 {
		body["max_tokens"] = req.MaxOutputTokens
	}
	if req.TopK > 0 {
		body["top_k"] = req.TopK
	}
	if req.MinP > 0 {
		body["min_p"] = req.MinP
	}
	if req.PresencePenalty != 0 {
		body["presence_penalty"] = req.PresencePenalty
	}
	if req.RepetitionPenalty > 0 {
		body["repetition_penalty"] = req.RepetitionPenalty
	}
	if p := req.SamplingProfile; p != nil {
		body["temperature"], body["top_p"], body["top_k"] = p.Temperature, p.TopP, p.TopK
		body["min_p"], body["presence_penalty"], body["repetition_penalty"] = p.MinP, p.PresencePenalty, p.RepetitionPenalty
	}
	// "on" is thinking without a degree, so there is no degree to send: a
	// template that reads only enable_thinking would ignore it, and one that
	// grades effort would be handed a level nobody chose.
	if req.ReasoningEffort != "" && req.ReasoningEffort != ReasoningNone && req.ReasoningEffort != ReasoningOff && req.ReasoningEffort != ReasoningOn {
		body["reasoning_effort"] = string(req.ReasoningEffort)
	}
	if req.ThinkingTokenBudget != nil {
		body["thinking_budget"] = *req.ThinkingTokenBudget
	}
	// Only chat templates that read enable_thinking act on it. Sending it
	// unasked would be a silent no-op on every other model, so it travels only
	// with an explicit directive — either a per-request one, or a configured
	// effort, which is itself a statement about whether to think.
	templateKwargs := map[string]any{}
	if req.Thinking != nil {
		templateKwargs["enable_thinking"] = *req.Thinking
		if *req.Thinking && req.ReasoningEffort != "" && req.ReasoningEffort != ReasoningOn && req.ReasoningEffort != ReasoningNone {
			templateKwargs["reasoning_effort"] = string(req.ReasoningEffort)
		}
	} else if c.mode == ModeLocal && req.ReasoningEffort == ReasoningOff {
		templateKwargs["enable_thinking"] = false
	} else if c.mode == ModeLocal && req.ReasoningEffort == ReasoningOn {
		templateKwargs["enable_thinking"] = true
	} else if c.mode == ModeLocal && req.ReasoningEffort != "" && req.ReasoningEffort != ReasoningNone {
		// llama.cpp forwards these kwargs into the template verbatim, which is
		// where Qwen's template reads the effort from. Local only: a server
		// fleet's template kwargs are its operator's to set, and overriding
		// them per request would quietly undo that configuration.
		templateKwargs["enable_thinking"] = true
		templateKwargs["reasoning_effort"] = string(req.ReasoningEffort)
	}
	if len(templateKwargs) > 0 {
		body["chat_template_kwargs"] = templateKwargs
	}
	if req.Tools != nil {
		body["tools"] = strictTools(req.Tools)
		if req.ToolChoice != nil {
			body["tool_choice"] = req.ToolChoice
		}
		body["parallel_tool_calls"] = req.ParallelTools
	}
	// Grammar-constrained decoding is a local-only lever: llama-server is ours
	// to constrain, a shared vLLM fleet is not.
	if c.mode == ModeLocal && req.ResponseSchema != nil {
		body["response_format"] = map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   "umbratic_structured_output",
				"schema": req.ResponseSchema,
				"strict": true,
			},
		}
	}
	return c.postJSON(ctx, c.chatEndpoint, body)
}

func (c *Client) postJSON(ctx context.Context, endpoint string, body any) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	c.setHeaders(httpReq)

	resp, err := c.client.Do(httpReq)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
			return nil, ProviderError{Kind: ProviderFailureTimeout, Cause: err}
		}
		var networkError net.Error
		if errors.As(err, &networkError) && networkError.Timeout() {
			return nil, ProviderError{Kind: ProviderFailureTimeout, Cause: err}
		}
		return nil, ProviderError{Kind: ProviderFailureTransport, Cause: err}
	}
	return resp, nil
}

func (c *Client) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
}

func decodeOpenAIChat(r io.Reader) (ChatResponse, error) {
	var decoded struct {
		Choices []struct {
			Message Message `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(io.LimitReader(r, 1<<20)).Decode(&decoded); err != nil {
		return ChatResponse{}, ProviderError{Kind: ProviderFailureInvalidResponse}
	}
	if len(decoded.Choices) == 0 {
		return ChatResponse{}, errors.New("model runtime returned no choices")
	}

	message := decoded.Choices[0].Message
	if message.Role == "" {
		message.Role = "assistant"
	}
	if message.Role != "assistant" {
		return ChatResponse{}, errors.New("model runtime returned a non-assistant message")
	}
	return ChatResponse{Message: message}, nil
}

func writeSSEData(dst io.Writer, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(dst, "data: %s\n\n", encoded); err != nil {
		return err
	}
	flushWriter(dst)
	return nil
}

func writeSSEDone(dst io.Writer) error {
	if _, err := io.WriteString(dst, "data: [DONE]\n\n"); err != nil {
		return err
	}
	flushWriter(dst)
	return nil
}

func flushWriter(w io.Writer) {
	flusher, ok := w.(interface{ Flush() })
	if ok {
		flusher.Flush()
	}
}

// openAIToolCallDeltas normalizes a runtime's tool-call array into the delta
// shape the runner consumes: stable indexes, an id per call, and arguments as
// a JSON string rather than an object.
func openAIToolCallDeltas(value any) []map[string]any {
	rows, ok := value.([]any)
	if !ok {
		return nil
	}
	toolCalls := make([]map[string]any, 0, len(rows))
	for i, raw := range rows {
		record, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		fn, _ := record["function"].(map[string]any)
		name, _ := fn["name"].(string)
		args := toolArgumentsString(fn["arguments"])
		id, _ := record["id"].(string)
		if id == "" {
			id = fmt.Sprintf("tool-%d", i)
		}
		toolCalls = append(toolCalls, map[string]any{
			"index": i,
			"id":    id,
			"type":  "function",
			"function": map[string]any{
				"name":      name,
				"arguments": args,
			},
		})
	}
	return toolCalls
}

func toolArgumentsString(value any) string {
	switch typed := value.(type) {
	case string:
		if typed == "" {
			return "{}"
		}
		return typed
	case nil:
		return "{}"
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return "{}"
		}
		return string(encoded)
	}
}

func modelInfosFromPayload(payload any) []ModelInfo {
	record, ok := payload.(map[string]any)
	if !ok {
		return nil
	}
	rows, _ := record["data"].([]any)
	if len(rows) == 0 {
		rows, _ = record["models"].([]any)
	}
	seen := map[string]bool{}
	models := []ModelInfo{}
	for _, row := range rows {
		var id string
		contextLength := 0
		if text, ok := row.(string); ok {
			id = strings.TrimSpace(text)
		} else if record, ok := row.(map[string]any); ok {
			for _, key := range []string{"id", "name", "model"} {
				text, ok := record[key].(string)
				if ok && strings.TrimSpace(text) != "" {
					id = strings.TrimSpace(text)
					break
				}
			}
			for _, key := range []string{"max_model_len", "max_context_length", "context_length"} {
				if parsed := positiveJSONInt(record[key]); parsed > 0 {
					contextLength = parsed
					break
				}
			}
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, ModelInfo{ID: id, ContextLength: contextLength})
	}
	return models
}

func positiveJSONInt(value any) int {
	switch typed := value.(type) {
	case float64:
		if typed > 0 && typed == float64(int(typed)) {
			return int(typed)
		}
	case int:
		if typed > 0 {
			return typed
		}
	case json.Number:
		parsed, err := typed.Int64()
		if err == nil && parsed > 0 && int64(int(parsed)) == parsed {
			return int(parsed)
		}
	}
	return 0
}

func providerEndpointURL(baseURL, endpointPath, defaultPath string) (string, error) {
	baseURL = strings.TrimSpace(baseURL)
	endpointPath = strings.TrimSpace(endpointPath)
	if endpointPath != "" {
		if strings.HasPrefix(endpointPath, "http://") || strings.HasPrefix(endpointPath, "https://") {
			endpoint, err := url.ParseRequestURI(endpointPath)
			if err != nil {
				return "", err
			}
			if endpoint.Host == "" {
				return "", errors.New("provider endpoint URL must include a host")
			}
			return endpointPath, nil
		}
	}

	if baseURL == "" {
		return "", errors.New("provider base URL is required")
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", errors.New("provider base URL must use http or https")
	}
	if base.Host == "" {
		return "", errors.New("provider base URL must include a host")
	}

	base.Path = strings.TrimRight(base.Path, "/")
	if endpointPath == "" {
		base.Path = joinEndpointPath(base.Path, defaultPath)
		return base.String(), nil
	}

	normalizedPath := strings.TrimLeft(endpointPath, "/")
	base.Path = joinEndpointPath(base.Path, normalizedPath)
	return base.String(), nil
}

func joinEndpointPath(basePath, endpointPath string) string {
	if basePath == "" {
		return "/" + strings.TrimLeft(endpointPath, "/")
	}

	baseVersion := pathVersion(basePath)
	endpointVersion := pathVersion(endpointPath)
	if baseVersion != "" && baseVersion == endpointVersion {
		endpointPath = strings.TrimPrefix(strings.TrimLeft(endpointPath, "/"), baseVersion+"/")
	} else if lastPathSegment(basePath) == firstPathSegment(endpointPath) {
		endpointPath = strings.TrimPrefix(strings.TrimLeft(endpointPath, "/"), firstPathSegment(endpointPath)+"/")
	}

	return strings.TrimRight(basePath, "/") + "/" + strings.TrimLeft(endpointPath, "/")
}

func pathVersion(path string) string {
	first := firstPathSegment(path)
	if len(first) < 2 || first[0] != 'v' {
		return ""
	}
	for _, char := range first[1:] {
		if char < '0' || char > '9' {
			return ""
		}
	}
	return first
}

func firstPathSegment(path string) string {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	if len(segments) == 0 {
		return ""
	}
	return segments[0]
}

func lastPathSegment(path string) string {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	if len(segments) == 0 {
		return ""
	}
	return segments[len(segments)-1]
}
