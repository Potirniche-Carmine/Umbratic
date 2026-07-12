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
	Skills     []prompts.SkillMetadata
}

const (
	ActionNone             = ""
	ActionChange           = "change"
	ActionExecute          = "execute"
	ActionChangeAndExecute = "change-and-execute"
)

// WorkspaceActionRequirement identifies evidence required by an explicit
// workspace request. Veil owns this classification so clients cannot weaken
// the action policy by changing their prompts.
func WorkspaceActionRequirement(messages []model.Message) string {
	var latest string
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role != "user" {
			continue
		}
		value, ok := messages[i].Content.(string)
		if !ok {
			return ActionNone
		}
		latest = strings.ToLower(strings.Join(strings.Fields(value), " "))
		if marker := strings.LastIndex(latest, "user request:"); marker >= 0 {
			latest = strings.TrimSpace(latest[marker+len("user request:"):])
		}
		break
	}
	if latest == "" || strings.HasPrefix(latest, "workspace tool results:") {
		return ActionNone
	}

	prefixes := []string{"please ", "can you ", "could you ", "would you ", "i need you to ", "i want you to "}
	for changed := true; changed; {
		changed = false
		for _, prefix := range prefixes {
			if strings.HasPrefix(latest, prefix) {
				latest = strings.TrimSpace(strings.TrimPrefix(latest, prefix))
				changed = true
				break
			}
		}
	}

	changeVerbs := []string{
		"add", "address", "build", "change", "create", "delete", "edit", "fix", "implement",
		"make", "modify", "move", "remove", "rename", "update", "write",
	}
	executeVerbs := []string{"execute", "run", "test", "verify"}
	change := false
	execute := false
	for _, verb := range changeVerbs {
		if latest == verb || strings.HasPrefix(latest, verb+" ") {
			change = true
			break
		}
	}
	for _, verb := range executeVerbs {
		if latest == verb || strings.HasPrefix(latest, verb+" ") || strings.Contains(latest, " and "+verb+" ") || strings.HasSuffix(latest, " and "+verb) {
			execute = true
			break
		}
	}
	if change && execute {
		return ActionChangeAndExecute
	}
	if change {
		return ActionChange
	}
	if execute {
		return ActionExecute
	}
	return ActionNone
}

type chatRequest struct {
	Input      string                  `json:"input"`
	Messages   []model.Message         `json:"messages"`
	Stream     bool                    `json:"stream"`
	Tools      any                     `json:"tools"`
	ToolChoice any                     `json:"tool_choice"`
	Skills     []prompts.SkillMetadata `json:"skills"`
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
		case "input", "messages", "stream", "tools", "tool_choice", "skills":
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
	skills, err := skillCatalog(req.Skills)
	if err != nil {
		return ChatInput{}, err
	}

	return ChatInput{
		Messages:   req.Messages,
		Stream:     req.Stream,
		Tools:      req.Tools,
		ToolChoice: req.ToolChoice,
		Skills:     skills,
	}, nil
}

func skillCatalog(values []prompts.SkillMetadata) ([]prompts.SkillMetadata, error) {
	if len(values) == 0 {
		return nil, nil
	}
	result := make([]prompts.SkillMetadata, 0, len(values))
	seen := make(map[string]bool, len(values))
	for index, value := range values {
		value.ID = strings.TrimSpace(value.ID)
		value.Name = strings.Join(strings.Fields(value.Name), " ")
		value.Description = strings.Join(strings.Fields(value.Description), " ")
		value.Source = strings.TrimSpace(value.Source)
		if !validSkillID(value.ID) {
			return nil, fmt.Errorf("skill %d has invalid id", index)
		}
		if value.Name == "" || len(value.Name) > 160 {
			return nil, fmt.Errorf("skill %q has invalid name", value.ID)
		}
		if len(value.Description) > 1000 {
			return nil, fmt.Errorf("skill %q description is too long", value.ID)
		}
		if value.Source != "system" && value.Source != "local" {
			return nil, fmt.Errorf("skill %q has invalid source", value.ID)
		}
		if seen[value.ID] {
			continue
		}
		seen[value.ID] = true
		result = append(result, value)
	}
	return result, nil
}

func validSkillID(value string) bool {
	if value == "" || len(value) > 96 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '_' || char == '-' {
			continue
		}
		return false
	}
	return true
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
