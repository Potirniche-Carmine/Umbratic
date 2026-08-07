package model

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

func writeVLLMAsSafeOpenAIChatSSE(dst io.Writer, src io.Reader, annotation UsageAnnotation) error {
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	sentDone := false
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
		stripPrivateReasoning(payload)
		annotateUsage(payload, annotation)
		if err := writeSSEData(dst, payload); err != nil {
			return err
		}
	}
	if scanner.Err() != nil || !sentDone {
		return ProviderError{Kind: ProviderFailureInvalidResponse}
	}
	return nil
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
