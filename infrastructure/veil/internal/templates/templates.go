package templates

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"umbratic-veil/internal/model"
)

const maxRegistryBytes = 512 * 1024
const maxSelectedTemplates = 3

var kindMatchPatterns = map[string]*regexp.Regexp{
	"powerpoint":   regexp.MustCompile(`\b(powerpoint|pptx|presentation|deck|slides?)\b`),
	"word":         regexp.MustCompile(`\b(docx|word document|word|memo|proposal document)\b`),
	"spreadsheets": regexp.MustCompile(`\b(xlsx|excel|spreadsheet|workbook|worksheet)\b`),
	"pdf":          regexp.MustCompile(`\b(pdf|one[-\s]?pager|report|whitepaper|white paper)\b`),
}

type Template struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	DisplayName string   `json:"displayName"`
	ServerKey   string   `json:"serverKey"`
	Version     string   `json:"version"`
	Tags        []string `json:"tags"`
	Description string   `json:"description"`
	Available   bool     `json:"available"`
	Checksum    string   `json:"checksum"`
	Routes      []string `json:"routes"`
}

type Registry struct {
	Templates []Template `json:"templates"`
}

func LoadFile(filePath string) (Registry, error) {
	if strings.TrimSpace(filePath) == "" {
		return Registry{}, nil
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return Registry{}, err
	}
	if len(data) > maxRegistryBytes {
		return Registry{}, errors.New("template registry is too large")
	}
	return Decode(data)
}

func Decode(data []byte) (Registry, error) {
	var wrapped Registry
	if err := json.Unmarshal(data, &wrapped); err == nil && wrapped.Templates != nil {
		return validate(wrapped)
	}
	var templates []Template
	if err := json.Unmarshal(data, &templates); err != nil {
		return Registry{}, errors.New("invalid template registry JSON")
	}
	return validate(Registry{Templates: templates})
}

func validate(registry Registry) (Registry, error) {
	if len(registry.Templates) > 64 {
		return Registry{}, errors.New("template registry has too many entries")
	}
	seen := make(map[string]bool, len(registry.Templates))
	for index, template := range registry.Templates {
		id := strings.TrimSpace(template.ID)
		kind := strings.TrimSpace(template.Kind)
		if id == "" || kind == "" || strings.TrimSpace(template.DisplayName) == "" || strings.TrimSpace(template.ServerKey) == "" || strings.TrimSpace(template.Version) == "" || strings.TrimSpace(template.Checksum) == "" {
			return Registry{}, fmt.Errorf("template %d is missing required metadata", index)
		}
		if seen[id] {
			return Registry{}, fmt.Errorf("template id %q is duplicated", id)
		}
		if !supportedKind(kind) {
			return Registry{}, fmt.Errorf("template %q has unsupported kind %q", id, kind)
		}
		seen[id] = true
		registry.Templates[index].ID = id
		registry.Templates[index].Kind = kind
		registry.Templates[index].DisplayName = strings.TrimSpace(template.DisplayName)
		registry.Templates[index].ServerKey = strings.TrimSpace(template.ServerKey)
		registry.Templates[index].Version = strings.TrimSpace(template.Version)
		registry.Templates[index].Checksum = strings.TrimSpace(template.Checksum)
		registry.Templates[index].Description = strings.TrimSpace(template.Description)
	}
	return registry, nil
}

func supportedKind(kind string) bool {
	switch kind {
	case "powerpoint", "word", "spreadsheets", "pdf":
		return true
	default:
		return false
	}
}

func (r Registry) ProtectedContext(route string, messages []model.Message) []model.Message {
	selected := r.Select(route, messages)
	if len(selected) == 0 {
		return nil
	}
	lines := []string{
		"Server-managed artifact templates available for this request:",
		"Use only this selected template metadata when a template is relevant. Do not invent unavailable templates or browse a wider template catalog.",
	}
	for _, template := range selected {
		lines = append(lines, fmt.Sprintf(
			"- id: %s; kind: %s; version: %s; serverKey: %s; checksum: %s; tags: %s; description: %s",
			template.ID,
			template.Kind,
			template.Version,
			template.ServerKey,
			template.Checksum,
			strings.Join(template.Tags, ", "),
			template.Description,
		))
	}
	lines = append(lines, "When the desktop pulls a selected template, it caches it locally under `.umbratic/templates/<kind>/<id>/` before local artifact generation and render/export verification.")
	return []model.Message{{Role: "system", Content: strings.Join(lines, "\n")}}
}

func (r Registry) Select(route string, messages []model.Message) []Template {
	query := strings.ToLower(messageText(messages))
	if strings.TrimSpace(query) == "" {
		return nil
	}
	selected := make([]Template, 0, maxSelectedTemplates)
	for _, template := range r.Templates {
		if len(selected) >= maxSelectedTemplates {
			break
		}
		if !template.Available || !routeAllowed(route, template.Routes) {
			continue
		}
		if templateMatches(template, query) {
			selected = append(selected, template)
		}
	}
	return selected
}

func routeAllowed(route string, routes []string) bool {
	if len(routes) == 0 {
		return true
	}
	for _, candidate := range routes {
		if strings.EqualFold(strings.TrimSpace(candidate), route) {
			return true
		}
	}
	return false
}

func templateMatches(template Template, query string) bool {
	if kindMatches(template.Kind, query) {
		return true
	}
	for _, token := range append(template.Tags, template.ID, template.DisplayName) {
		token = strings.ToLower(strings.TrimSpace(token))
		if len(token) >= 3 && strings.Contains(query, token) {
			return true
		}
	}
	return false
}

func kindMatches(kind string, query string) bool {
	pattern := kindMatchPatterns[kind]
	return pattern != nil && pattern.MatchString(query)
}

func messageText(messages []model.Message) string {
	var builder strings.Builder
	for _, message := range messages {
		switch content := message.Content.(type) {
		case string:
			builder.WriteString(content)
			builder.WriteByte('\n')
		case []any:
			for _, part := range content {
				if row, ok := part.(map[string]any); ok {
					if text, ok := row["text"].(string); ok {
						builder.WriteString(text)
						builder.WriteByte('\n')
					}
				}
			}
		}
	}
	return builder.String()
}
