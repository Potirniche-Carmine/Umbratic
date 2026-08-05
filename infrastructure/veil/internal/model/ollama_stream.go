package model

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// Ollama speaks newline-delimited JSON. This is the whole of the conversion
// into the OpenAI-shaped SSE that the rest of the product consumes, kept
// beside nothing else so the two stream dialects never blur together.

func writeOllamaAsOpenAIChatSSE(dst io.Writer, src io.Reader, annotation UsageAnnotation) error {
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	sentRole := false
	sentDone := false
	var pendingToolCalls any

	for scanner.Scan() {
		trimmed := strings.TrimSpace(scanner.Text())
		if trimmed == "" {
			continue
		}
		done, roleSent, toolCalls, lineErr := writeOllamaLineAsOpenAIChatSSE(
			dst,
			trimmed,
			sentRole,
			pendingToolCalls,
			annotation,
		)
		if lineErr != nil {
			return lineErr
		}
		if roleSent {
			sentRole = true
		}
		pendingToolCalls = toolCalls
		if done {
			sentDone = true
		}
	}
	if scanner.Err() != nil {
		return ProviderError{Kind: ProviderFailureInvalidResponse}
	}
	if !sentDone {
		return ProviderError{Kind: ProviderFailureInvalidResponse}
	}
	return nil
}

func writeOllamaLineAsOpenAIChatSSE(
	dst io.Writer,
	line string,
	roleAlreadySent bool,
	pendingToolCalls any,
	annotation UsageAnnotation,
) (bool, bool, any, error) {
	var row map[string]any
	if err := json.Unmarshal([]byte(line), &row); err != nil {
		return false, roleAlreadySent, pendingToolCalls, ProviderError{Kind: ProviderFailureInvalidResponse}
	}

	message, _ := row["message"].(map[string]any)
	delta := make(map[string]any)
	if !roleAlreadySent && message != nil {
		role, _ := message["role"].(string)
		if role == "" {
			role = "assistant"
		}
		if role != "assistant" {
			return false, roleAlreadySent, pendingToolCalls, errors.New("model runtime returned a non-assistant message")
		}
		delta["role"] = role
		roleAlreadySent = true
	}
	if content := textFromRuntimeValue(message["content"]); content != "" {
		delta["content"] = content
	}
	if message != nil {
		if toolCalls, ok := message["tool_calls"]; ok && toolCalls != nil {
			pendingToolCalls = toolCalls
		}
	}
	if len(delta) > 0 {
		if err := writeSSEData(dst, map[string]any{
			"choices": []any{
				map[string]any{"delta": delta},
			},
		}); err != nil {
			return false, roleAlreadySent, pendingToolCalls, err
		}
	}

	done, _ := row["done"].(bool)
	if !done {
		return false, roleAlreadySent, pendingToolCalls, nil
	}

	// Emit the final tool-call snapshot once before usage/DONE so the runner
	// receives complete parallel calls with stable indexes instead of merging
	// repeated Ollama stream chunks onto index 0.
	if toolCalls := openAIToolCallDeltas(pendingToolCalls); len(toolCalls) > 0 {
		if err := writeSSEData(dst, map[string]any{
			"choices": []any{
				map[string]any{"delta": map[string]any{"tool_calls": toolCalls}},
			},
		}); err != nil {
			return false, roleAlreadySent, nil, err
		}
	}
	promptTokens, promptOK := runtimeTokenCount(row["prompt_eval_count"])
	completionTokens, completionOK := runtimeTokenCount(row["eval_count"])
	if promptOK || completionOK {
		payload := map[string]any{
			"choices": []any{},
			"usage": map[string]any{
				"prompt_tokens":     promptTokens,
				"completion_tokens": completionTokens,
				"total_tokens":      promptTokens + completionTokens,
			},
		}
		annotateUsage(payload, annotation)
		if err := writeSSEData(dst, payload); err != nil {
			return false, roleAlreadySent, nil, err
		}
	}
	if err := writeSSEDone(dst); err != nil {
		return false, roleAlreadySent, nil, err
	}
	return true, roleAlreadySent, nil, nil
}
