package policy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"umbratic-veil/internal/model"
	"umbratic-veil/internal/prompts"
)

const (
	MaxMessages     = 64
	MaxMessageBytes = 64 * 1024
)

var ErrRequestTooLarge = errors.New("request body too large")

type ChatInput struct {
	Messages   []model.Message
	Stream     bool
	Tools      any
	ToolChoice any
	Profiles   []prompts.RuntimeProfile
}

type chatRequest struct {
	Input           string          `json:"input"`
	Messages        []model.Message `json:"messages"`
	Stream          bool            `json:"stream"`
	Tools           any             `json:"tools"`
	ToolChoice      any             `json:"tool_choice"`
	RuntimeProfiles []string        `json:"runtime_profiles"`
}

func DecodeChatInput(r io.Reader) (ChatInput, error) {
	body, err := io.ReadAll(r)
	if err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			return ChatInput{}, ErrRequestTooLarge
		}
		return ChatInput{}, errors.New("invalid request body")
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return ChatInput{}, errors.New("invalid JSON request")
	}
	for field := range raw {
		switch field {
		case "input", "messages", "stream", "tools", "tool_choice", "runtime_profiles":
		case "model", "system":
			return ChatInput{}, fmt.Errorf("field %q is not allowed", field)
		default:
			return ChatInput{}, fmt.Errorf("field %q is not supported", field)
		}
	}

	var req chatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return ChatInput{}, errors.New("invalid JSON request")
	}
	if strings.TrimSpace(req.Input) != "" && len(req.Messages) > 0 {
		return ChatInput{}, errors.New("use either input or messages, not both")
	}
	if strings.TrimSpace(req.Input) != "" {
		req.Messages = []model.Message{{Role: "user", Content: req.Input}}
	}
	if len(req.Messages) == 0 {
		return ChatInput{}, errors.New("at least one user message is required")
	}
	if len(req.Messages) > MaxMessages {
		return ChatInput{}, fmt.Errorf("too many messages; maximum is %d", MaxMessages)
	}
	for i, message := range req.Messages {
		if message.Role != "user" && message.Role != "assistant" && message.Role != "tool" {
			return ChatInput{}, fmt.Errorf("message %d has unsupported role", i)
		}
		if message.Role == "user" || message.Role == "tool" {
			if contentIsBlank(message.Content) {
				return ChatInput{}, fmt.Errorf("message %d content is required", i)
			}
		}
		if encodedSize(message.Content) > MaxMessageBytes {
			return ChatInput{}, fmt.Errorf("message %d is too large", i)
		}
	}
	profiles, err := runtimeProfiles(req.RuntimeProfiles)
	if err != nil {
		return ChatInput{}, err
	}

	return ChatInput{
		Messages:   req.Messages,
		Stream:     req.Stream,
		Tools:      req.Tools,
		ToolChoice: req.ToolChoice,
		Profiles:   profiles,
	}, nil
}

func runtimeProfiles(values []string) ([]prompts.RuntimeProfile, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > 8 {
		return nil, errors.New("too many runtime profiles")
	}
	profiles := make([]prompts.RuntimeProfile, 0, len(values))
	seen := make(map[prompts.RuntimeProfile]bool, len(values))
	for _, value := range values {
		profile := prompts.RuntimeProfile(strings.TrimSpace(value))
		if profile == "" {
			continue
		}
		if !prompts.IsRuntimeProfile(profile) {
			return nil, fmt.Errorf("runtime profile %q is not supported", value)
		}
		if !seen[profile] {
			seen[profile] = true
			profiles = append(profiles, profile)
		}
	}
	return profiles, nil
}

func contentIsBlank(content any) bool {
	switch value := content.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(value) == ""
	case []any:
		return contentPartsAreBlank(value)
	default:
		return false
	}
}

func contentPartsAreBlank(parts []any) bool {
	if len(parts) == 0 {
		return true
	}
	for _, part := range parts {
		switch value := part.(type) {
		case string:
			if strings.TrimSpace(value) != "" {
				return false
			}
		case map[string]any:
			if contentPartHasValue(value) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func contentPartHasValue(part map[string]any) bool {
	if text, ok := part["text"].(string); ok && strings.TrimSpace(text) != "" {
		return true
	}
	if partType, _ := part["type"].(string); partType == "image_url" {
		switch image := part["image_url"].(type) {
		case string:
			return strings.TrimSpace(image) != ""
		case map[string]any:
			url, _ := image["url"].(string)
			return strings.TrimSpace(url) != ""
		}
	}
	return false
}

func encodedSize(value any) int {
	encoded, err := json.Marshal(value)
	if err != nil {
		return MaxMessageBytes + 1
	}
	return len(encoded)
}
