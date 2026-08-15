package model

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
)

// UsageAnnotation is Veil's report of its own protected prefix, forwarded on
// the final usage frame. The runner needs it because it never sees the system
// messages Veil prepends, and so cannot size them.
type UsageAnnotation struct {
	SystemPromptTokens int
	Exact              bool
}

// The prefix changes only when the route, the playbook bucket, or the skill
// catalog changes, so the cache is small by construction. The cap is a bound
// against a client cycling skill catalogs to grow it without limit.
const maxPrefixTokenCacheEntries = 64

type prefixTokenCache struct {
	mu      sync.Mutex
	entries map[string]UsageAnnotation
}

func (c *prefixTokenCache) get(key string) (UsageAnnotation, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	annotation, ok := c.entries[key]
	return annotation, ok
}

func (c *prefixTokenCache) put(key string, annotation UsageAnnotation) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]UsageAnnotation)
	}
	if len(c.entries) >= maxPrefixTokenCacheEntries {
		c.entries = make(map[string]UsageAnnotation)
	}
	c.entries[key] = annotation
}

func prefixText(messages []Message) string {
	var builder strings.Builder
	for _, message := range messages {
		if content, ok := message.Content.(string); ok {
			builder.WriteString(content)
			builder.WriteByte('\n')
		}
	}
	return builder.String()
}

// PrefixTokens sizes the assembled protected prefix, exactly where the runtime
// can tokenize it and by byte length where it cannot.
//
// The result is cached under a caller-supplied key covering every input to the
// prefix, so this costs one tokenize call per distinct prefix rather than one
// per request.
func (c *Client) PrefixTokens(ctx context.Context, key, modelID string, messages []Message) UsageAnnotation {
	if len(messages) == 0 {
		return UsageAnnotation{}
	}
	// Two models tokenize the same prefix differently, so the model id is part
	// of the identity of a cached count, not just of the request that asked.
	key = modelID + "\x00" + key
	if annotation, ok := c.prefixTokens.get(key); ok {
		return annotation
	}
	annotation := UsageAnnotation{SystemPromptTokens: estimatedPrefixTokens(messages)}
	if exact, ok := c.tokenizePrefix(ctx, modelID, messages); ok {
		annotation = UsageAnnotation{SystemPromptTokens: exact, Exact: true}
	}
	c.prefixTokens.put(key, annotation)
	return annotation
}

// The fallback for a tokenize call that did not answer. Four bytes per token
// is the same order of magnitude every harness uses for a preflight estimate,
// and the `exact` flag is what stops the desktop from presenting it as a
// measurement.
func estimatedPrefixTokens(messages []Message) int {
	return (len(prefixText(messages)) + 3) / 4
}

// tokenizePrefix asks the runtime to count the prefix exactly.
//
// Both runtimes answer at /tokenize with `{"tokens":[...]}`, but they disagree
// on what to send: vLLM takes the chat shape and applies the template itself,
// while llama-server tokenizes one `content` string. Sending either body to the
// other runtime is a 400, so the shape follows the mode.
func (c *Client) tokenizePrefix(ctx context.Context, modelID string, messages []Message) (int, bool) {
	body := map[string]any{"model": modelID, "messages": messages}
	if c.mode == ModeLocal {
		body = map[string]any{"content": prefixText(messages)}
	}
	resp, err := c.postJSON(ctx, c.tokenizeEndpoint, body)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return 0, false
	}
	var payload struct {
		Count  int   `json:"count"`
		Tokens []any `json:"tokens"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload); err != nil {
		return 0, false
	}
	// vLLM reports `count`; llama-server reports only the token array.
	count := payload.Count
	if count <= 0 {
		count = len(payload.Tokens)
	}
	if count <= 0 {
		return 0, false
	}
	return count, true
}

func annotateUsage(payload map[string]any, annotation UsageAnnotation) {
	usage, ok := payload["usage"].(map[string]any)
	if !ok || annotation.SystemPromptTokens <= 0 {
		return
	}
	usage["system_prompt_tokens"] = annotation.SystemPromptTokens
	usage["system_prompt_tokens_exact"] = annotation.Exact
}
