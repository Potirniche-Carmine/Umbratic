package supervisor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"umbratic-veil-console/internal/config"
)

// probeGeneration checks that the runtime can actually generate, not merely that
// it lists the model. Listing a model says nothing about whether the chat
// template loads, whether streaming works, or whether tool calls come back in
// the shape the runner requires — all of which fail at the first real request
// instead of at configuration time.
func probeGeneration(ctx context.Context, cfg config.Veil) error {
	if err := probeStreamedCompletion(ctx, cfg); err != nil {
		return err
	}
	return probeStrictToolCall(ctx, cfg)
}

func probeStreamedCompletion(ctx context.Context, cfg config.Veil) error {
	body := map[string]any{
		"model":      cfg.Model,
		"messages":   []map[string]string{{"role": "user", "content": "Reply with the single word: ready"}},
		"stream":     true,
		"max_tokens": 16,
	}
	payload, err := chatCompletion(ctx, cfg, body)
	if err != nil {
		return errors.New("streamed completion probe failed: " + err.Error())
	}
	if !bytes.Contains(payload, []byte("data:")) {
		return errors.New("streamed completion probe returned no server-sent events")
	}
	return nil
}

func probeStrictToolCall(ctx context.Context, cfg config.Veil) error {
	body := map[string]any{
		"model":    cfg.Model,
		"messages": []map[string]string{{"role": "user", "content": "Call probe_ok with value set to 1."}},
		"stream":   false,
		"tools": []map[string]any{{
			"type": "function",
			"function": map[string]any{
				"name":        "probe_ok",
				"description": "Confirms the runtime can emit a strict tool call.",
				"strict":      true,
				"parameters": map[string]any{
					"type":                 "object",
					"properties":           map[string]any{"value": map[string]any{"type": "integer"}},
					"required":             []string{"value"},
					"additionalProperties": false,
				},
			},
		}},
		"tool_choice": map[string]any{
			"type":     "function",
			"function": map[string]string{"name": "probe_ok"},
		},
		"max_tokens": 64,
	}
	payload, err := chatCompletion(ctx, cfg, body)
	if err != nil {
		return errors.New("tool-call probe failed: " + err.Error())
	}
	if !bytes.Contains(payload, []byte("probe_ok")) {
		return errors.New("runtime did not return a forced tool call; check the tool-call parser")
	}
	return nil
}

// chatCompletion posts one bounded request through the same guarded transport
// the model listing uses, so a probe cannot reach anything the listing could not.
func chatCompletion(ctx context.Context, cfg config.Veil, body map[string]any) ([]byte, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return providerRequest(ctx, cfg, "/v1/chat/completions", encoded)
}

// readBoundedStream reads at most a few events so a probe never depends on the
// runtime finishing a generation.
func readBoundedStream(reader io.Reader) []byte {
	scanner := bufio.NewScanner(io.LimitReader(reader, 64<<10))
	scanner.Buffer(make([]byte, 0, 8<<10), 32<<10)
	var collected strings.Builder
	for lines := 0; lines < 32 && scanner.Scan(); lines++ {
		collected.WriteString(scanner.Text())
		collected.WriteString("\n")
		if strings.Contains(scanner.Text(), "[DONE]") {
			break
		}
	}
	return []byte(collected.String())
}

func drainProbeResponse(response *http.Response) ([]byte, error) {
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, errors.New("runtime rejected the probe request")
	}
	return readBoundedStream(response.Body), nil
}
