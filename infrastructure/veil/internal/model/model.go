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
	Model               string
	Messages            []Message
	Stream              bool
	Tools               any
	ToolChoice          any
	ParallelTools       bool
	MaxOutputTokens     int
	Temperature         float64
	TopP                float64
	ReasoningEffort     ReasoningEffort
	ThinkingTokenBudget *int
	// ResponseSchema constrains local generation to this JSON schema via
	// Ollama structured outputs. nil leaves generation unconstrained. The
	// model may still think freely first — Ollama carries thinking in its own
	// channel — but the content it returns can only be this shape. Local mode
	// only; the server path ignores it.
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
}

type Client struct {
	mode             Mode
	chatEndpoint     string
	modelsEndpoint   string
	metricsEndpoint  string
	generateEndpoint string
	showEndpoint     string
	tokenizeEndpoint string
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

	chatDefaultPath := "v1/chat/completions"
	modelsDefaultPath := "v1/models"
	if mode == ModeLocal {
		chatDefaultPath = "api/chat"
		modelsDefaultPath = "api/tags"
	}

	chatEndpoint, err := providerEndpointURL(cfg.BaseURL, "", chatDefaultPath)
	if err != nil {
		return nil, err
	}
	modelsEndpoint, err := providerEndpointURL(cfg.BaseURL, "", modelsDefaultPath)
	if err != nil {
		return nil, err
	}
	metricsEndpoint, err := providerEndpointURL(cfg.BaseURL, "", "metrics")
	if err != nil {
		return nil, err
	}
	// vLLM exposes /tokenize at the server root. Ollama has no stable
	// equivalent, so the local mode never resolves one and falls back to a
	// flagged byte-length estimate.
	tokenizeEndpoint := ""
	if mode == ModeServer {
		tokenizeEndpoint, err = providerEndpointURL(cfg.BaseURL, "", "tokenize")
		if err != nil {
			return nil, err
		}
	}
	generateEndpoint := ""
	showEndpoint := ""
	if mode == ModeLocal {
		generateEndpoint, err = providerEndpointURL(cfg.BaseURL, "", "api/generate")
		if err != nil {
			return nil, err
		}
		showEndpoint, err = providerEndpointURL(cfg.BaseURL, "", "api/show")
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
		generateEndpoint: generateEndpoint,
		showEndpoint:     showEndpoint,
		tokenizeEndpoint: tokenizeEndpoint,
		contextLength:    cfg.ContextLength,
		client:           hardenedHTTPClient(timeout),
	}, nil
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

// ollamaKeepAlive keeps the loaded model resident between requests. Ollama's
// default is five minutes, after which the next request pays the full cold
// load — routinely tens of seconds, which is exactly what blew the runner's
// orient timeout in a live run. Every request refreshes the window, so this
// only needs to exceed ordinary thinking time between prompts.
const ollamaKeepAlive = "60m"

func (c *Client) ActivateModel(ctx context.Context, modelID string) error {
	if c.mode != ModeLocal {
		return nil
	}
	body := map[string]any{
		"model":      modelID,
		"stream":     false,
		"keep_alive": ollamaKeepAlive,
	}
	if c.contextLength > 0 {
		body["options"] = map[string]any{"num_ctx": c.contextLength}
	}
	resp, err := c.postJSON(ctx, c.generateEndpoint, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ProviderError{StatusCode: resp.StatusCode, Kind: ProviderFailureStatus}
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

	switch c.mode {
	case ModeServer:
		return decodeVLLMChat(resp.Body)
	case ModeLocal:
		return decodeOllamaChat(resp.Body)
	default:
		return ChatResponse{}, fmt.Errorf("unsupported Veil mode %q", c.mode)
	}
}

func (c *Client) DoChat(ctx context.Context, req ChatRequest) (*http.Response, error) {
	switch c.mode {
	case ModeServer:
		return c.doVLLMChat(ctx, req)
	case ModeLocal:
		return c.doOllamaChat(ctx, req)
	default:
		return nil, fmt.Errorf("unsupported Veil mode %q", c.mode)
	}
}

func WriteOpenAIChatSSE(ctx context.Context, mode Mode, dst io.Writer, src io.Reader, idleTimeout time.Duration, annotation UsageAnnotation) error {
	src = withIdleAndCancel(ctx, src, idleTimeout)
	switch mode {
	case ModeServer:
		return writeVLLMAsSafeOpenAIChatSSE(dst, src, annotation)
	case ModeLocal:
		return writeOllamaAsOpenAIChatSSE(dst, src, annotation)
	default:
		return fmt.Errorf("unsupported Veil mode %q", mode)
	}
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

	resp, err := c.postJSON(ctx, c.showEndpoint, map[string]any{"model": modelID})
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return 0, ProviderError{StatusCode: resp.StatusCode, Kind: ProviderFailureStatus}
	}
	var payload any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return 0, ProviderError{Kind: ProviderFailureInvalidResponse}
	}
	contextLength := ollamaContextLengthFromPayload(payload)
	if contextLength <= 0 {
		return 0, errors.New("model runtime did not report a context length")
	}
	return contextLength, nil
}

func (c *Client) doVLLMChat(ctx context.Context, req ChatRequest) (*http.Response, error) {
	body := map[string]any{
		"model":       req.Model,
		"messages":    req.Messages,
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
	if req.ReasoningEffort != "" && req.ReasoningEffort != ReasoningNone {
		body["reasoning_effort"] = string(req.ReasoningEffort)
	}
	if req.ThinkingTokenBudget != nil {
		body["thinking_budget"] = *req.ThinkingTokenBudget
	}
	if req.Tools != nil {
		body["tools"] = strictTools(req.Tools)
		if req.ToolChoice != nil {
			body["tool_choice"] = req.ToolChoice
		}
		body["parallel_tool_calls"] = req.ParallelTools
	}
	return c.postJSON(ctx, c.chatEndpoint, body)
}

func (c *Client) doOllamaChat(ctx context.Context, req ChatRequest) (*http.Response, error) {
	body := map[string]any{
		"model":      req.Model,
		"messages":   ollamaMessages(req.Messages),
		"stream":     req.Stream,
		"keep_alive": ollamaKeepAlive,
	}
	if req.ResponseSchema != nil {
		body["format"] = req.ResponseSchema
	}
	if req.Tools != nil {
		body["tools"] = req.Tools
	}
	options := map[string]any{
		"temperature": req.Temperature,
		"top_p":       req.TopP,
	}
	if c.contextLength > 0 {
		options["num_ctx"] = c.contextLength
	}
	if req.MaxOutputTokens > 0 {
		options["num_predict"] = req.MaxOutputTokens
	}
	body["options"] = options
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
}

func decodeVLLMChat(r io.Reader) (ChatResponse, error) {
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

func decodeOllamaChat(r io.Reader) (ChatResponse, error) {
	var decoded struct {
		Message Message `json:"message"`
	}
	if err := json.NewDecoder(io.LimitReader(r, 1<<20)).Decode(&decoded); err != nil {
		return ChatResponse{}, ProviderError{Kind: ProviderFailureInvalidResponse}
	}
	if decoded.Message.Content == nil {
		return ChatResponse{}, errors.New("model runtime returned an empty message")
	}
	if decoded.Message.Role == "" {
		decoded.Message.Role = "assistant"
	}
	if decoded.Message.Role != "assistant" {
		return ChatResponse{}, errors.New("model runtime returned a non-assistant message")
	}
	return ChatResponse{Message: decoded.Message}, nil
}

func runtimeTokenCount(value any) (int, bool) {
	count, ok := value.(float64)
	if !ok || count < 0 || count != float64(int(count)) {
		return 0, false
	}
	return int(count), true
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

func textFromRuntimeValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, part := range typed {
			switch row := part.(type) {
			case string:
				if row != "" {
					parts = append(parts, row)
				}
			case map[string]any:
				text, _ := row["text"].(string)
				if text != "" {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}

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

func ollamaMessages(messages []Message) []map[string]any {
	rows := make([]map[string]any, 0, len(messages))
	systemParts := make([]string, 0, 2)
	toolNames := make(map[string]string)
	for _, message := range messages {
		if message.Role != "system" {
			continue
		}
		if content := ollamaContent(message.Content); content != "" {
			systemParts = append(systemParts, content)
		}
	}
	if len(systemParts) > 0 {
		rows = append(rows, map[string]any{
			"role":    "system",
			"content": strings.Join(systemParts, "\n\n"),
		})
	}
	for _, message := range messages {
		if message.Role == "system" {
			continue
		}
		content, images := ollamaContentParts(message.Content)
		row := map[string]any{
			"role":    message.Role,
			"content": content,
		}
		if len(images) > 0 {
			row["images"] = images
		}
		if message.ToolCalls != nil {
			row["tool_calls"] = ollamaToolCalls(message.ToolCalls, toolNames)
		}
		if message.Role == "tool" && message.ToolCallID != "" {
			if name := toolNames[message.ToolCallID]; name != "" {
				row["tool_name"] = name
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func ollamaToolCalls(value any, toolNames map[string]string) []map[string]any {
	rows, ok := value.([]any)
	if !ok {
		return nil
	}
	converted := make([]map[string]any, 0, len(rows))
	for _, raw := range rows {
		call, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		function, ok := call["function"].(map[string]any)
		if !ok {
			continue
		}
		name, _ := function["name"].(string)
		arguments := function["arguments"]
		if encoded, ok := arguments.(string); ok {
			var decoded any
			if json.Unmarshal([]byte(encoded), &decoded) == nil {
				arguments = decoded
			}
		}
		converted = append(converted, map[string]any{
			"function": map[string]any{
				"name":      name,
				"arguments": arguments,
			},
		})
		if id, _ := call["id"].(string); id != "" && name != "" {
			toolNames[id] = name
		}
	}
	return converted
}

func ollamaContent(content any) string {
	text, _ := ollamaContentParts(content)
	return text
}

func ollamaContentParts(content any) (string, []string) {
	switch value := content.(type) {
	case string:
		return value, nil
	case []any:
		parts := make([]string, 0, len(value))
		images := make([]string, 0)
		for _, part := range value {
			row, ok := part.(map[string]any)
			if !ok {
				continue
			}
			switch row["type"] {
			case "text":
				text, ok := row["text"].(string)
				if ok && text != "" {
					parts = append(parts, text)
				}
			case "image_url":
				image, _ := row["image_url"].(map[string]any)
				dataURL, _ := image["url"].(string)
				if _, payload, ok := strings.Cut(dataURL, ","); ok && payload != "" {
					images = append(images, payload)
				}
			}
		}
		return strings.Join(parts, "\n\n"), images
	default:
		return "", nil
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

func ollamaContextLengthFromPayload(payload any) int {
	record, ok := payload.(map[string]any)
	if !ok {
		return 0
	}
	modelInfo, ok := record["model_info"].(map[string]any)
	if !ok {
		return 0
	}
	contextLength := 0
	for key, value := range modelInfo {
		if !strings.HasSuffix(strings.ToLower(key), ".context_length") && !strings.EqualFold(key, "context_length") {
			continue
		}
		if parsed := positiveJSONInt(value); parsed > contextLength {
			contextLength = parsed
		}
	}
	return contextLength
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
