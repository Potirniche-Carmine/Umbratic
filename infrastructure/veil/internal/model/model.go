package model

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	Model      string
	Messages   []Message
	Stream     bool
	Tools      any
	ToolChoice any
}

type ChatResponse struct {
	Message Message
}

type ModelInfo struct {
	ID string `json:"id"`
}

type ProviderProtocol string

const (
	ProtocolVLLM   ProviderProtocol = "vllm"
	ProtocolOllama ProviderProtocol = "ollama"
)

type ClientConfig struct {
	Protocol           ProviderProtocol
	BaseURL            string
	ChatEndpointPath   string
	ModelsEndpointPath string
	APIKey             string
	Timeout            time.Duration
}

type Client struct {
	protocol       ProviderProtocol
	chatEndpoint   string
	modelsEndpoint string
	apiKey         string
	client         *http.Client
}

type ProviderError struct {
	StatusCode int
}

func (e ProviderError) Error() string {
	if e.StatusCode == 0 {
		return "model runtime request failed"
	}
	return fmt.Sprintf("model runtime returned status %d", e.StatusCode)
}

func ParseProviderProtocol(value string) (ProviderProtocol, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "vllm":
		return ProtocolVLLM, nil
	case "ollama":
		return ProtocolOllama, nil
	default:
		return "", fmt.Errorf("unsupported model runtime protocol %q", value)
	}
}

func NewClient(cfg ClientConfig) (*Client, error) {
	protocol := cfg.Protocol
	if protocol == "" {
		protocol = ProtocolVLLM
	}

	chatDefaultPath := "v1/chat/completions"
	modelsDefaultPath := "v1/models"
	if protocol == ProtocolOllama {
		chatDefaultPath = "api/chat"
		modelsDefaultPath = "api/tags"
	}

	chatEndpoint, err := providerEndpointURL(cfg.BaseURL, cfg.ChatEndpointPath, chatDefaultPath)
	if err != nil {
		return nil, err
	}
	modelsEndpoint, err := providerEndpointURL(cfg.BaseURL, cfg.ModelsEndpointPath, modelsDefaultPath)
	if err != nil {
		return nil, err
	}

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Client{
		protocol:       protocol,
		chatEndpoint:   chatEndpoint,
		modelsEndpoint: modelsEndpoint,
		apiKey:         cfg.APIKey,
		client: &http.Client{
			Timeout: timeout,
		},
	}, nil
}

func (c *Client) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	resp, err := c.DoChat(ctx, req)
	if err != nil {
		return ChatResponse{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return ChatResponse{}, ProviderError{StatusCode: resp.StatusCode}
	}

	switch c.protocol {
	case ProtocolVLLM:
		return decodeVLLMChat(resp.Body)
	case ProtocolOllama:
		return decodeOllamaChat(resp.Body)
	default:
		return ChatResponse{}, fmt.Errorf("unsupported model runtime protocol %q", c.protocol)
	}
}

func (c *Client) DoChat(ctx context.Context, req ChatRequest) (*http.Response, error) {
	switch c.protocol {
	case ProtocolVLLM:
		return c.doVLLMChat(ctx, req)
	case ProtocolOllama:
		return c.doOllamaChat(ctx, req)
	default:
		return nil, fmt.Errorf("unsupported model runtime protocol %q", c.protocol)
	}
}

func WriteOpenAIChatSSE(protocol ProviderProtocol, dst io.Writer, src io.Reader) error {
	switch protocol {
	case "", ProtocolVLLM:
		_, err := io.Copy(flushingWriter{w: dst}, src)
		return err
	case ProtocolOllama:
		return writeOllamaAsOpenAIChatSSE(dst, src)
	default:
		return fmt.Errorf("unsupported model runtime protocol %q", protocol)
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
		return nil, ProviderError{}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, ProviderError{StatusCode: resp.StatusCode}
	}

	var payload any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return nil, ProviderError{}
	}

	ids := modelIDsFromPayload(payload)
	models := make([]ModelInfo, 0, len(ids))
	for _, id := range ids {
		models = append(models, ModelInfo{ID: id})
	}
	return models, nil
}

func (c *Client) doVLLMChat(ctx context.Context, req ChatRequest) (*http.Response, error) {
	body := map[string]any{
		"model":    req.Model,
		"messages": req.Messages,
		"stream":   req.Stream,
	}
	if req.Tools != nil {
		body["tools"] = req.Tools
	}
	if req.ToolChoice != nil {
		body["tool_choice"] = req.ToolChoice
	}
	return c.postJSON(ctx, c.chatEndpoint, body)
}

func (c *Client) doOllamaChat(ctx context.Context, req ChatRequest) (*http.Response, error) {
	body := map[string]any{
		"model":    req.Model,
		"messages": ollamaMessages(req.Messages),
		"stream":   req.Stream,
	}
	if req.Tools != nil {
		body["tools"] = req.Tools
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
		return nil, ProviderError{}
	}
	return resp, nil
}

func (c *Client) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(c.apiKey) != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
}

func decodeVLLMChat(r io.Reader) (ChatResponse, error) {
	var decoded struct {
		Choices []struct {
			Message Message `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(io.LimitReader(r, 1<<20)).Decode(&decoded); err != nil {
		return ChatResponse{}, ProviderError{}
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
		return ChatResponse{}, ProviderError{}
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

type flushingWriter struct {
	w io.Writer
}

func (w flushingWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	if err == nil {
		flushWriter(w.w)
	}
	return n, err
}

func writeOllamaAsOpenAIChatSSE(dst io.Writer, src io.Reader) error {
	reader := bufio.NewReader(src)
	sentRole := false
	sentDone := false

	for {
		line, err := reader.ReadString('\n')
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			done, roleSent, err := writeOllamaLineAsOpenAIChatSSE(dst, trimmed, sentRole)
			if err != nil {
				return err
			}
			if roleSent {
				sentRole = true
			}
			if done {
				sentDone = true
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return ProviderError{}
		}
	}
	if !sentDone {
		return writeSSEDone(dst)
	}
	return nil
}

func writeOllamaLineAsOpenAIChatSSE(dst io.Writer, line string, roleAlreadySent bool) (bool, bool, error) {
	var row map[string]any
	if err := json.Unmarshal([]byte(line), &row); err != nil {
		return false, roleAlreadySent, ProviderError{}
	}

	message, _ := row["message"].(map[string]any)
	delta := make(map[string]any)
	if !roleAlreadySent && message != nil {
		role, _ := message["role"].(string)
		if role == "" {
			role = "assistant"
		}
		if role != "assistant" {
			return false, roleAlreadySent, errors.New("model runtime returned a non-assistant message")
		}
		delta["role"] = role
		roleAlreadySent = true
	}
	if content := textFromRuntimeValue(message["content"]); content != "" {
		delta["content"] = content
	}
	for _, key := range []string{"reasoning_content", "reasoning", "thinking"} {
		if text := textFromRuntimeValue(message[key]); text != "" {
			delta[key] = text
			break
		}
	}
	if toolCalls := openAIToolCallDeltas(message["tool_calls"]); len(toolCalls) > 0 {
		delta["tool_calls"] = toolCalls
	}
	if len(delta) > 0 {
		if err := writeSSEData(dst, map[string]any{
			"choices": []any{
				map[string]any{"delta": delta},
			},
		}); err != nil {
			return false, roleAlreadySent, err
		}
	}

	done, _ := row["done"].(bool)
	if done {
		if err := writeSSEDone(dst); err != nil {
			return false, roleAlreadySent, err
		}
	}
	return done, roleAlreadySent, nil
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
	for _, message := range messages {
		row := map[string]any{
			"role":    message.Role,
			"content": ollamaContent(message.Content),
		}
		if message.ToolCallID != "" {
			row["tool_call_id"] = message.ToolCallID
		}
		if message.ToolCalls != nil {
			row["tool_calls"] = message.ToolCalls
		}
		rows = append(rows, row)
	}
	return rows
}

func ollamaContent(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		parts := make([]string, 0, len(value))
		for _, part := range value {
			row, ok := part.(map[string]any)
			if !ok || row["type"] != "text" {
				continue
			}
			text, ok := row["text"].(string)
			if ok && text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n\n")
	default:
		return ""
	}
}

func modelIDsFromPayload(payload any) []string {
	record, ok := payload.(map[string]any)
	if !ok {
		return nil
	}
	rows, _ := record["data"].([]any)
	if len(rows) == 0 {
		rows, _ = record["models"].([]any)
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, row := range rows {
		var id string
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
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
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
