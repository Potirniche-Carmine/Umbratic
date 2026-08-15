package model

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

// Both runtimes stream OpenAI SSE, so there is one reader for both. It
// forwards frames rather than rebuilding them: whatever the runtime already
// structured — tool calls above all — must reach the runner unchanged.
func writeSafeOpenAIChatSSE(mode Mode, dst io.Writer, src io.Reader, annotation UsageAnnotation, forwardReasoning bool) error {
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	sentDone := false
	// The healer runs on the local path only. A server fleet's stream is
	// forwarded exactly as it arrives.
	var healer *toolCallHealer
	if mode == ModeLocal {
		healer = &toolCallHealer{}
	}
	for scanner.Scan() {
		trimmed := strings.TrimSpace(scanner.Text())
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "data:") {
			if strings.HasPrefix(trimmed, ":") || strings.HasPrefix(trimmed, "event:") {
				continue
			}
			return ProviderError{Kind: ProviderFailureInvalidResponse}
		}
		data := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
		if data == "[DONE]" {
			// Anything the healer was still holding belongs before the marker.
			if healer != nil {
				visible, calls := healer.flush()
				if err := writeHealedFrame(dst, visible, calls); err != nil {
					return err
				}
			}
			if err := writeSSEDone(dst); err != nil {
				return err
			}
			sentDone = true
			continue
		}
		var payload map[string]any
		if json.Unmarshal([]byte(data), &payload) != nil {
			return ProviderError{Kind: ProviderFailureInvalidResponse}
		}
		if !forwardReasoning {
			stripPrivateReasoning(payload)
		}
		annotateUsage(payload, annotation)
		var calls []map[string]any
		if healer != nil {
			calls = healContentInPlace(payload, healer)
		}
		if err := writeSSEData(dst, payload); err != nil {
			return err
		}
		if err := writeHealedFrame(dst, "", calls); err != nil {
			return err
		}
	}
	if scanner.Err() != nil || !sentDone {
		return ProviderError{Kind: ProviderFailureInvalidResponse}
	}
	return nil
}

// healContentInPlace rewrites the visible content of one frame and returns any
// tool calls the healer recovered from it. A frame whose whole content was held
// back loses the field rather than carrying an empty string, so the renderer
// never renders a blank delta.
func healContentInPlace(payload map[string]any, healer *toolCallHealer) []map[string]any {
	var calls []map[string]any
	choices, _ := payload["choices"].([]any)
	for _, rawChoice := range choices {
		choice, _ := rawChoice.(map[string]any)
		for _, field := range []string{"delta", "message"} {
			message, _ := choice[field].(map[string]any)
			if message == nil {
				continue
			}
			// A frame that already carries structured calls is llama.cpp's own
			// parse. Leave it, and leave the healer's state alone with it.
			if _, structured := message["tool_calls"]; structured {
				continue
			}
			content, ok := message["content"].(string)
			if !ok {
				continue
			}
			visible, recovered := healer.feed(content)
			calls = append(calls, recovered...)
			if visible == "" {
				delete(message, "content")
				continue
			}
			message["content"] = visible
		}
	}
	return calls
}

// writeHealedFrame emits one delta carrying recovered text and tool calls, and
// nothing when there is neither.
func writeHealedFrame(dst io.Writer, visible string, calls []map[string]any) error {
	delta := map[string]any{}
	if visible != "" {
		delta["content"] = visible
	}
	if len(calls) > 0 {
		delta["tool_calls"] = calls
	}
	if len(delta) == 0 {
		return nil
	}
	return writeSSEData(dst, map[string]any{"choices": []any{map[string]any{"delta": delta}}})
}

func stripPrivateReasoning(payload map[string]any) {
	choices, _ := payload["choices"].([]any)
	for _, rawChoice := range choices {
		choice, _ := rawChoice.(map[string]any)
		for _, field := range []string{"delta", "message"} {
			message, _ := choice[field].(map[string]any)
			delete(message, "reasoning_content")
			delete(message, "reasoning")
			delete(message, "thinking")
		}
	}
}
