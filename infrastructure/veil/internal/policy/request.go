package policy

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"umbratic-veil/internal/model"
	"umbratic-veil/internal/prompts"
)

const (
	MaxMessages         = 512
	MaxMessageBytes     = 256 * 1024
	MaxImageBytes       = 10 * 1024 * 1024
	MaxImagesPerMessage = 12
	MaxOutputTokens     = 32 * 1024
	MaxSkills           = 128
	MaxTools            = 32
)

var ErrRequestTooLarge = errors.New("request body too large")

type CompactionInput struct {
	Route            string
	PreviousSummary  string
	Messages         []model.Message
	MaxSummaryTokens int
	SourceDigest     string
}

type compactionRequest struct {
	Route            string          `json:"route"`
	PreviousSummary  string          `json:"previousSummary"`
	Messages         []model.Message `json:"messages"`
	MaxSummaryTokens int             `json:"maxSummaryTokens"`
	SourceDigest     string          `json:"sourceDigest"`
}

func DecodeCompactionInput(r io.Reader) (CompactionInput, error) {
	body, err := io.ReadAll(r)
	if err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			return CompactionInput{}, ErrRequestTooLarge
		}
		return CompactionInput{}, errors.New("invalid request body")
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(body, &raw) != nil {
		return CompactionInput{}, errors.New("invalid JSON request")
	}
	for field := range raw {
		switch field {
		case "route", "previousSummary", "messages", "maxSummaryTokens", "sourceDigest":
		default:
			return CompactionInput{}, fmt.Errorf("field %q is not supported", field)
		}
	}
	var req compactionRequest
	if json.Unmarshal(body, &req) != nil {
		return CompactionInput{}, errors.New("invalid JSON request")
	}
	if req.Route != "engineering" && req.Route != "marketing" && req.Route != "sales" {
		return CompactionInput{}, errors.New("unsupported compaction route")
	}
	if len(req.PreviousSummary) > 24_000 {
		return CompactionInput{}, errors.New("previous summary is too large")
	}
	if len(req.Messages) == 0 || len(req.Messages) > MaxMessages {
		return CompactionInput{}, errors.New("compaction messages are missing or too numerous")
	}
	if req.MaxSummaryTokens < 200 || req.MaxSummaryTokens > 4096 {
		return CompactionInput{}, errors.New("maxSummaryTokens must be between 200 and 4096")
	}
	if len(req.SourceDigest) != 64 {
		return CompactionInput{}, errors.New("sourceDigest is invalid")
	}
	for _, c := range req.SourceDigest {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return CompactionInput{}, errors.New("sourceDigest is invalid")
		}
	}
	for i, message := range req.Messages {
		if message.Role != "user" && message.Role != "assistant" && message.Role != "tool" {
			return CompactionInput{}, fmt.Errorf("message %d has unsupported role", i)
		}
		if err := validateMessageContent(message.Content); err != nil {
			return CompactionInput{}, fmt.Errorf("message %d %s", i, err)
		}
	}
	return CompactionInput{Route: req.Route, PreviousSummary: req.PreviousSummary, Messages: req.Messages, MaxSummaryTokens: req.MaxSummaryTokens, SourceDigest: req.SourceDigest}, nil
}

// MaxOrientRequestBytes bounds the classifier input. The runner already head-
// and-tail truncates to this size, so a larger body is a protocol error.
const MaxOrientRequestBytes = 32 * 1024

// OrientInput is the strict classify-only request. It carries no messages,
// no tools, and no client-supplied prompt text.
type OrientInput struct {
	// Route is the full route string, matching the prompts route constants
	// rather than compaction's bare profile names.
	Route prompts.Route
	// RequestText is the current run's user text, and the only thing classified.
	RequestText string
	// PreviousResponse is the tail of the assistant's last reply, carried as
	// context so a short follow-up can be resolved. No bucket travels with it:
	// the classifier reads what was offered and judges the answer on merit.
	PreviousResponse string
}

type orientRequest struct {
	Route            string `json:"route"`
	RequestText      string `json:"requestText"`
	PreviousResponse string `json:"previousResponse"`
}

// DecodeOrientInput strictly decodes the orient request. Unknown fields, an
// unknown route, or an out-of-range request text are all rejected outright.
func DecodeOrientInput(r io.Reader) (OrientInput, error) {
	body, err := io.ReadAll(r)
	if err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			return OrientInput{}, ErrRequestTooLarge
		}
		return OrientInput{}, errors.New("invalid request body")
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(body, &raw) != nil {
		return OrientInput{}, errors.New("invalid JSON request")
	}
	for field := range raw {
		switch field {
		case "route", "requestText", "previousResponse":
		default:
			return OrientInput{}, fmt.Errorf("field %q is not supported", field)
		}
	}
	var req orientRequest
	if json.Unmarshal(body, &req) != nil {
		return OrientInput{}, errors.New("invalid JSON request")
	}
	route := prompts.Route(req.Route)
	if _, ok := prompts.RouteBuckets(route); !ok {
		return OrientInput{}, errors.New("unsupported orient route")
	}
	if strings.TrimSpace(req.RequestText) == "" {
		return OrientInput{}, errors.New("requestText is required")
	}
	if len(req.RequestText) > MaxOrientRequestBytes {
		return OrientInput{}, errors.New("requestText is too large")
	}
	if !utf8.ValidString(req.RequestText) {
		return OrientInput{}, errors.New("requestText must be valid UTF-8")
	}
	// Context is a convenience, never a reason to fail a run: anything oversized
	// or not valid UTF-8 is dropped and the request classifies without it.
	previous := req.PreviousResponse
	if len(previous) > MaxOrientRequestBytes || !utf8.ValidString(previous) {
		previous = ""
	}
	return OrientInput{Route: route, RequestText: req.RequestText, PreviousResponse: previous}, nil
}

type ChatInput struct {
	Messages        []model.Message
	Stream          bool
	Tools           any
	Skills          []prompts.SkillMetadata
	MaxOutputTokens int
	// HarnessBucket is protected control metadata, not system text. A caller can
	// select a catalog bucket for the endpoint's route and nothing else.
	HarnessBucket string
}

type chatRequest struct {
	Input           string                  `json:"input"`
	Messages        []model.Message         `json:"messages"`
	Stream          bool                    `json:"stream"`
	Tools           any                     `json:"tools"`
	Skills          []prompts.SkillMetadata `json:"skills"`
	MaxOutputTokens int                     `json:"max_output_tokens"`
	HarnessBucket   string                  `json:"harness_bucket"`
}

// DecodeChatInput validates a chat request for a specific route. The route is
// required because harness_bucket is a closed per-route enum: a selector that is
// valid on another route must be rejected here, before prompt assembly.
func DecodeChatInput(r io.Reader, route prompts.Route) (ChatInput, error) {
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
		case "input", "messages", "stream", "tools", "skills", "max_output_tokens", "harness_bucket":
		case "model", "system", "tool_choice", "parallel_tool_calls", "temperature", "top_p":
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
	if req.MaxOutputTokens < 0 || req.MaxOutputTokens > MaxOutputTokens {
		return ChatInput{}, fmt.Errorf("max_output_tokens must be between 1 and %d when set", MaxOutputTokens)
	}
	if err := validateToolContract(req.Tools); err != nil {
		return ChatInput{}, err
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
		if err := validateMessageContent(message.Content); err != nil {
			return ChatInput{}, fmt.Errorf("message %d %s", i, err)
		}
	}
	skills, err := skillCatalog(req.Skills)
	if err != nil {
		return ChatInput{}, err
	}
	// direct_answer never carries a playbook, so selecting it is meaningless and
	// is rejected rather than silently ignored.
	if req.HarnessBucket != "" &&
		(req.HarnessBucket == prompts.DirectAnswerBucket || !prompts.KnownBucket(route, req.HarnessBucket)) {
		return ChatInput{}, fmt.Errorf("harness_bucket %q is not valid for this route", req.HarnessBucket)
	}

	return ChatInput{
		Messages:        req.Messages,
		Stream:          req.Stream,
		Tools:           req.Tools,
		Skills:          skills,
		MaxOutputTokens: req.MaxOutputTokens,
		HarnessBucket:   req.HarnessBucket,
	}, nil
}

func validateToolContract(tools any) error {
	if tools == nil {
		return nil
	}
	rows, ok := tools.([]any)
	if !ok || len(rows) == 0 || len(rows) > MaxTools {
		return fmt.Errorf("tools must contain between 1 and %d function definitions", MaxTools)
	}
	seen := make(map[string]bool, len(rows))
	for index, raw := range rows {
		tool, ok := raw.(map[string]any)
		if !ok || len(tool) != 2 || tool["type"] != "function" {
			return fmt.Errorf("tool %d must be one exact function definition", index)
		}
		function, ok := tool["function"].(map[string]any)
		if !ok || len(function) != 3 {
			return fmt.Errorf("tool %d function must contain name, description, and parameters", index)
		}
		name, _ := function["name"].(string)
		description, _ := function["description"].(string)
		if !validToolName(name) || strings.TrimSpace(description) == "" || len(description) > 2000 {
			return fmt.Errorf("tool %d has an invalid name or description", index)
		}
		if seen[name] {
			return fmt.Errorf("tool %d duplicates function name %q", index, name)
		}
		seen[name] = true
		parameters, ok := function["parameters"].(map[string]any)
		if !ok || len(parameters) != 4 || parameters["type"] != "object" || parameters["additionalProperties"] != false {
			return fmt.Errorf("tool %q parameters must be one closed object schema", name)
		}
		properties, ok := parameters["properties"].(map[string]any)
		if !ok {
			return fmt.Errorf("tool %q properties must be an object", name)
		}
		for field, definition := range properties {
			if !validToolPropertyName(field) {
				return fmt.Errorf("tool %q has an invalid property name", name)
			}
			schema, ok := definition.(map[string]any)
			if !ok {
				return fmt.Errorf("tool %q property %q must be a schema object", name, field)
			}
			if err := validateToolPropertySchema(name, field, schema); err != nil {
				return err
			}
		}
		required, ok := parameters["required"].([]any)
		if !ok {
			return fmt.Errorf("tool %q required must be an array", name)
		}
		requiredSeen := make(map[string]bool, len(required))
		for _, rawField := range required {
			field, ok := rawField.(string)
			if !ok || requiredSeen[field] {
				return fmt.Errorf("tool %q required fields must be unique strings", name)
			}
			if _, exists := properties[field]; !exists {
				return fmt.Errorf("tool %q requires undeclared property %q", name, field)
			}
			requiredSeen[field] = true
		}
	}
	return nil
}

func validateToolPropertySchema(toolName, field string, schema map[string]any) error {
	return validateToolPropertySchemaAtDepth(toolName, field, schema, 1)
}

const maxToolSchemaDepth = 3

func validateToolPropertySchemaAtDepth(toolName, field string, schema map[string]any, depth int) error {
	if depth > maxToolSchemaDepth {
		return fmt.Errorf("tool %q property %q nests too deeply", toolName, field)
	}
	typeName, ok := schema["type"].(string)
	if !ok {
		return fmt.Errorf("tool %q property %q has an unsupported type", toolName, field)
	}
	allowed := map[string]bool{
		"type": true, "description": true, "enum": true, "items": true,
		"minLength": true, "maxLength": true, "minimum": true, "maximum": true,
		"minItems": true, "maxItems": true,
	}
	if typeName == "object" {
		allowed["properties"] = true
		allowed["required"] = true
		allowed["additionalProperties"] = true
	}
	for keyword := range schema {
		if !allowed[keyword] {
			return fmt.Errorf("tool %q property %q has unsupported schema keyword %q", toolName, field, keyword)
		}
	}
	switch typeName {
	case "string", "integer", "number", "boolean", "array", "object":
	default:
		return fmt.Errorf("tool %q property %q has an unsupported type", toolName, field)
	}
	if description, exists := schema["description"]; exists {
		text, ok := description.(string)
		if !ok || len(text) > 2000 {
			return fmt.Errorf("tool %q property %q has an invalid description", toolName, field)
		}
	}
	for _, keyword := range []string{"minLength", "maxLength", "minItems", "maxItems"} {
		if value, exists := schema[keyword]; exists {
			number, ok := value.(float64)
			if !ok || number < 0 || number != float64(int64(number)) {
				return fmt.Errorf("tool %q property %q has an invalid %s", toolName, field, keyword)
			}
		}
	}
	for _, keyword := range []string{"minimum", "maximum"} {
		if value, exists := schema[keyword]; exists {
			if _, ok := value.(float64); !ok {
				return fmt.Errorf("tool %q property %q has an invalid %s", toolName, field, keyword)
			}
		}
	}
	if enum, exists := schema["enum"]; exists {
		if typeName == "object" || typeName == "array" {
			return fmt.Errorf("tool %q property %q enum does not match its type", toolName, field)
		}
		values, ok := enum.([]any)
		if !ok || len(values) == 0 || len(values) > 128 {
			return fmt.Errorf("tool %q property %q has an invalid enum", toolName, field)
		}
		seen := make(map[string]bool, len(values))
		for _, value := range values {
			if !schemaValueHasType(value, typeName) {
				return fmt.Errorf("tool %q property %q enum does not match its type", toolName, field)
			}
			encoded, _ := json.Marshal(value)
			if seen[string(encoded)] {
				return fmt.Errorf("tool %q property %q enum values must be unique", toolName, field)
			}
			seen[string(encoded)] = true
		}
	}
	items, hasItems := schema["items"]
	properties, hasProperties := schema["properties"]
	required, hasRequired := schema["required"]
	additionalProperties, hasAdditionalProperties := schema["additionalProperties"]
	switch typeName {
	case "array":
		itemSchema, ok := items.(map[string]any)
		if !hasItems || !ok {
			return fmt.Errorf("tool %q property %q array items must be a schema object", toolName, field)
		}
		if hasProperties || hasRequired || hasAdditionalProperties {
			return fmt.Errorf("tool %q property %q uses object keywords with a non-object type", toolName, field)
		}
		return validateToolPropertySchemaAtDepth(toolName, field+"[]", itemSchema, depth+1)
	case "object":
		if hasItems {
			return fmt.Errorf("tool %q property %q uses items with a non-array type", toolName, field)
		}
		if !hasAdditionalProperties || additionalProperties != false {
			return fmt.Errorf("tool %q property %q must be a closed object schema", toolName, field)
		}
		nestedProperties, ok := properties.(map[string]any)
		if !hasProperties || !ok || len(nestedProperties) == 0 {
			return fmt.Errorf("tool %q property %q properties must be a non-empty object", toolName, field)
		}
		if len(nestedProperties) > 32 {
			return fmt.Errorf("tool %q property %q declares too many nested properties", toolName, field)
		}
		for nestedField, definition := range nestedProperties {
			if !validToolPropertyName(nestedField) {
				return fmt.Errorf("tool %q property %q has an invalid nested property name", toolName, field)
			}
			nestedSchema, ok := definition.(map[string]any)
			if !ok {
				return fmt.Errorf("tool %q property %q.%s must be a schema object", toolName, field, nestedField)
			}
			if err := validateToolPropertySchemaAtDepth(toolName, field+"."+nestedField, nestedSchema, depth+1); err != nil {
				return err
			}
		}
		if !hasRequired {
			return fmt.Errorf("tool %q property %q required must be an array", toolName, field)
		}
		requiredFields, ok := required.([]any)
		if !ok {
			return fmt.Errorf("tool %q property %q required must be an array", toolName, field)
		}
		requiredSeen := make(map[string]bool, len(requiredFields))
		for _, rawField := range requiredFields {
			nestedField, ok := rawField.(string)
			if !ok || requiredSeen[nestedField] {
				return fmt.Errorf("tool %q property %q required fields must be unique strings", toolName, field)
			}
			if _, exists := nestedProperties[nestedField]; !exists {
				return fmt.Errorf("tool %q property %q requires undeclared nested property %q", toolName, field, nestedField)
			}
			requiredSeen[nestedField] = true
		}
		return nil
	default:
		if hasItems {
			return fmt.Errorf("tool %q property %q uses items with a non-array type", toolName, field)
		}
		if hasProperties || hasRequired || hasAdditionalProperties {
			return fmt.Errorf("tool %q property %q uses object keywords with a non-object type", toolName, field)
		}
		return nil
	}
}

func schemaValueHasType(value any, typeName string) bool {
	switch typeName {
	case "string":
		_, ok := value.(string)
		return ok
	case "integer":
		number, ok := value.(float64)
		return ok && number == float64(int64(number))
	case "number":
		_, ok := value.(float64)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	default:
		return false
	}
}

func validToolName(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '_' {
			continue
		}
		return false
	}
	return true
}

func validToolPropertyName(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for index, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char == '_' || (index > 0 && char >= '0' && char <= '9') {
			continue
		}
		return false
	}
	return true
}

func skillCatalog(values []prompts.SkillMetadata) ([]prompts.SkillMetadata, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > MaxSkills {
		return nil, fmt.Errorf("too many skills; maximum is %d", MaxSkills)
	}
	result := make([]prompts.SkillMetadata, 0, len(values))
	seen := make(map[string]bool, len(values))
	for index, value := range values {
		value.ID = strings.TrimSpace(value.ID)
		value.Name = strings.Join(strings.Fields(value.Name), " ")
		value.Description = strings.Join(strings.Fields(value.Description), " ")
		value.Source = strings.TrimSpace(value.Source)
		if len(value.Paths) > 32 {
			return nil, fmt.Errorf("skill %q has too many path globs", value.ID)
		}
		for pathIndex, skillPath := range value.Paths {
			skillPath = strings.TrimSpace(skillPath)
			if skillPath == "" || len(skillPath) > 240 || strings.Contains(skillPath, "\x00") {
				return nil, fmt.Errorf("skill %q has invalid path glob", value.ID)
			}
			value.Paths[pathIndex] = skillPath
		}
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
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return MaxMessageBytes + 1
	}
	return encoded.Len() - 1
}

func validateMessageContent(content any) error {
	parts, structured := content.([]any)
	if !structured {
		if encodedSize(content) > MaxMessageBytes {
			return errors.New("is too large")
		}
		return nil
	}

	textOnly := make([]any, 0, len(parts))
	imageCount := 0
	for _, part := range parts {
		row, ok := part.(map[string]any)
		if !ok || row["type"] != "image_url" {
			textOnly = append(textOnly, part)
			continue
		}
		imageCount++
		if imageCount > MaxImagesPerMessage {
			return fmt.Errorf("contains too many images; maximum is %d", MaxImagesPerMessage)
		}
		image, ok := row["image_url"].(map[string]any)
		if !ok || len(row) != 2 {
			return errors.New("contains an invalid image")
		}
		for key := range image {
			if key != "url" && key != "detail" {
				return errors.New("contains an invalid image")
			}
		}
		if detail, exists := image["detail"]; exists && detail != "auto" && detail != "low" && detail != "high" {
			return errors.New("contains an invalid image detail")
		}
		dataURL, _ := image["url"].(string)
		if err := validateImageDataURL(dataURL); err != nil {
			return err
		}
		textOnly = append(textOnly, map[string]any{
			"type":      "image_url",
			"image_url": map[string]any{"url": "[image]"},
		})
	}
	if encodedSize(textOnly) > MaxMessageBytes {
		return errors.New("text content is too large")
	}
	return nil
}

func validateImageDataURL(value string) error {
	header, payload, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(strings.ToLower(header), "data:image/") || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return errors.New("contains an invalid image data URL")
	}
	if base64.StdEncoding.DecodedLen(len(payload)) > MaxImageBytes {
		return fmt.Errorf("contains an image larger than %d bytes", MaxImageBytes)
	}
	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return errors.New("contains invalid base64 image data")
	}
	if len(decoded) > MaxImageBytes {
		return fmt.Errorf("contains an image larger than %d bytes", MaxImageBytes)
	}
	return nil
}
