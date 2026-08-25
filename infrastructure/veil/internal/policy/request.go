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
	// MaxToolBytes and MaxSkillBytes are the real limits now that neither payload
	// is inspected field by field: what matters is that they fit the prompt.
	MaxToolBytes  = 128 * 1024
	MaxSkillBytes = 64 * 1024
	// MaxHarnessBucketBytes bounds a free-form selector; a longer one is a bug.
	MaxHarnessBucketBytes = 64
)

const (
	maxSkillIDBytes          = 96
	maxSkillNameBytes        = 160
	maxSkillDescriptionBytes = 1000
	maxSkillSourceBytes      = 32
	maxSkillPaths            = 32
	maxSkillPathBytes        = 240
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
	stripUnknownFields(raw, "route", "previousSummary", "messages", "maxSummaryTokens", "sourceDigest")
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

// DecodeOrientInput decodes the orient request. An unknown route or an
// out-of-range request text are rejected; unknown fields are stripped and
// counted, because a newer harness may carry classifier hints this build has
// never seen.
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
	stripUnknownFields(raw, "route", "requestText", "previousResponse")
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

// MaxWebSearchQueryBytes bounds one web search query. The runner's tool catalog
// already asks the model for something far shorter; this is the boundary check
// that stops a client's mistake from becoming an outbound request, not a promise
// about what a well-behaved caller sends.
const MaxWebSearchQueryBytes = 512

type WebSearchInput struct {
	Query string
}

type webSearchRequest struct {
	Query string `json:"query"`
}

// DecodeWebSearchInput decodes a web search request. The query is bounded and
// refused when it is empty or carries control characters; unknown fields are
// stripped and counted, because a newer harness may carry search hints this
// build has never seen.
func DecodeWebSearchInput(r io.Reader) (WebSearchInput, error) {
	body, err := io.ReadAll(r)
	if err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			return WebSearchInput{}, ErrRequestTooLarge
		}
		return WebSearchInput{}, errors.New("invalid request body")
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(body, &raw) != nil {
		return WebSearchInput{}, errors.New("invalid JSON request")
	}
	stripUnknownFields(raw, "query")
	var req webSearchRequest
	if json.Unmarshal(body, &req) != nil {
		return WebSearchInput{}, errors.New("invalid JSON request")
	}
	query := strings.TrimSpace(req.Query)
	if query == "" {
		return WebSearchInput{}, errors.New("query is required")
	}
	if len(query) > MaxWebSearchQueryBytes {
		return WebSearchInput{}, errors.New("query is too large")
	}
	if !utf8.ValidString(query) {
		return WebSearchInput{}, errors.New("query must be valid UTF-8")
	}
	// A control character in a query is never something a person typed. It is a
	// header-splitting or log-forging attempt reaching for the outbound request
	// this route is about to make.
	if strings.ContainsFunc(query, func(char rune) bool { return char < 0x20 || char == 0x7f }) {
		return WebSearchInput{}, errors.New("query must not contain control characters")
	}
	return WebSearchInput{Query: query}, nil
}

type ChatInput struct {
	Messages        []model.Message
	Stream          bool
	Tools           any
	Skills          []prompts.SkillMetadata
	MaxOutputTokens int
	// HarnessBucket is accepted and ignored: it does not change the prompt.
	HarnessBucket string
	// Model is the registry id the caller picked, empty for the server default.
	// It is only ever set when the server published a registry to pick from.
	Model string
	// Thinking is "on", "off", or empty. A hint like HarnessBucket: an
	// unreadable value falls through to empty rather than failing the request.
	Thinking string
	// ReasoningVisible is true only for a JSON boolean true. Anything else —
	// absent, a string, an object a later harness invents — is false, which is
	// the same request a client that never sent the field would have made.
	ReasoningVisible bool
}

type chatRequest struct {
	Input           string                  `json:"input"`
	Messages        []model.Message         `json:"messages"`
	Stream          bool                    `json:"stream"`
	Tools           any                     `json:"tools"`
	Skills          []prompts.SkillMetadata `json:"skills"`
	MaxOutputTokens int                     `json:"max_output_tokens"`
	HarnessBucket   string                  `json:"harness_bucket"`
	Model           string                  `json:"model"`
	// Thinking decodes as any so a harness that sends a shape this build has no
	// reader for is treated as having sent nothing, rather than being refused.
	Thinking         any `json:"thinking"`
	ReasoningVisible any `json:"reasoning_visible"`
}

// normalizeThinkingDirective reads the tolerant thinking hint. Anything that is
// not exactly "on" or "off" — a bool, a number, a word invented later — means
// "no directive", which is the same request a client that never sent the field
// would have made.
func normalizeThinkingDirective(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "on":
		return "on"
	case "off":
		return "off"
	default:
		return ""
	}
}

// DecodeChatInput validates a chat request for a specific route. Validation is
// bounds and authority only: sizes and counts are enforced, client attempts to
// write system text are rejected, and everything else the harness sends is
// passed through or stripped. The route still selects the route prompt.
//
// allowedModels is the registry this server published. Empty means the server
// never offered a choice, so naming a model stays refused loudly — a client
// that thinks it picked a model must never be silently answered by another one.
func DecodeChatInput(r io.Reader, route prompts.Route, allowedModels []string) (ChatInput, error) {
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
	// Authority, not vocabulary: a client that writes system text is refused
	// loudly rather than silently ignored, because silently ignoring it would
	// let the caller believe it took effect. The same is true of `model` on a
	// server that publishes no registry. Sampling and tool-choice knobs are the
	// admin's to set, so they are stripped like any other unrecognized field.
	refused := []string{"system"}
	if len(allowedModels) == 0 {
		refused = append(refused, "model")
	}
	for _, field := range refused {
		if _, present := raw[field]; present {
			return ChatInput{}, fmt.Errorf("field %q is not allowed", field)
		}
	}
	stripUnknownFields(raw, "input", "messages", "stream", "tools", "skills", "max_output_tokens", "harness_bucket", "model", "thinking", "reasoning_visible")

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
	// harness_bucket is a hint, not an enum. Any value is accepted. Unknown
	// values are counted. The field does not change the protected prompt.
	bucket := strings.TrimSpace(req.HarnessBucket)
	if len(bucket) > MaxHarnessBucketBytes {
		bucket = ""
	}
	if bucket != "" && !prompts.KnownBucket(route, bucket) {
		noteUnknownHarnessBucket()
	}

	// A named model must be one this server actually routes to. Falling back to
	// the default would answer with a model the caller did not ask for.
	selectedModel := strings.TrimSpace(req.Model)
	if selectedModel != "" {
		known := false
		for _, allowed := range allowedModels {
			known = known || allowed == selectedModel
		}
		if !known {
			return ChatInput{}, fmt.Errorf("model %q is not available", selectedModel)
		}
	}

	return ChatInput{
		Messages:         req.Messages,
		Stream:           req.Stream,
		Tools:            req.Tools,
		Skills:           skills,
		MaxOutputTokens:  req.MaxOutputTokens,
		HarnessBucket:    bucket,
		Model:            selectedModel,
		Thinking:         normalizeThinkingDirective(req.Thinking),
		ReasoningVisible: normalizeReasoningVisible(req.ReasoningVisible),
	}, nil
}

// normalizeReasoningVisible is the tolerant reader for the show-thinking hint.
// Only a JSON true forwards reasoning; every other shape is "do not show",
// which is also the default.
func normalizeReasoningVisible(value any) bool {
	flag, ok := value.(bool)
	return ok && flag
}

// validateToolContract is bounds-only. Veil does not arbitrate tool schemas:
// the admin controls the runtime, so a construct the provider cannot handle is
// the provider's error to raise as a failed turn, not Veil's to pre-guess. What
// is enforced here is that the payload is well-formed, bounded, and names its
// functions — everything a newer harness invents inside a definition passes
// through untouched.
func validateToolContract(tools any) error {
	if tools == nil {
		return nil
	}
	rows, ok := tools.([]any)
	if !ok || len(rows) == 0 || len(rows) > MaxTools {
		return fmt.Errorf("tools must contain between 1 and %d function definitions", MaxTools)
	}
	if encodedSize(tools) > MaxToolBytes {
		return fmt.Errorf("tools are larger than %d bytes", MaxToolBytes)
	}
	for index, raw := range rows {
		tool, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("tool %d must be an object", index)
		}
		function, ok := tool["function"].(map[string]any)
		if !ok {
			return fmt.Errorf("tool %d must carry a function definition", index)
		}
		if name, _ := function["name"].(string); strings.TrimSpace(name) == "" {
			return fmt.Errorf("tool %d must have a name", index)
		}
	}
	return nil
}

// skillCatalog is bounds-only. Skill entries are untrusted metadata that ends up
// as catalog prose, so what matters is that there are not too many, that they do
// not blow the prompt budget, and that each is short enough to render — not that
// the harness described them with the fields this build happens to know.
func skillCatalog(values []prompts.SkillMetadata) ([]prompts.SkillMetadata, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > MaxSkills {
		return nil, fmt.Errorf("too many skills; maximum is %d", MaxSkills)
	}
	if encodedSize(values) > MaxSkillBytes {
		return nil, fmt.Errorf("skills are larger than %d bytes", MaxSkillBytes)
	}
	result := make([]prompts.SkillMetadata, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		value.ID = clamp(strings.TrimSpace(value.ID), maxSkillIDBytes)
		value.Name = clamp(strings.Join(strings.Fields(value.Name), " "), maxSkillNameBytes)
		value.Description = clamp(strings.Join(strings.Fields(value.Description), " "), maxSkillDescriptionBytes)
		value.Source = clamp(strings.TrimSpace(value.Source), maxSkillSourceBytes)
		// An entry with no id cannot be referenced or deduplicated, so it is the
		// one shape that is dropped rather than clamped.
		if value.ID == "" || seen[value.ID] {
			continue
		}
		if len(value.Paths) > maxSkillPaths {
			value.Paths = value.Paths[:maxSkillPaths]
		}
		paths := make([]string, 0, len(value.Paths))
		for _, skillPath := range value.Paths {
			skillPath = strings.TrimSpace(strings.ReplaceAll(skillPath, "\x00", ""))
			if skillPath == "" {
				continue
			}
			paths = append(paths, clamp(skillPath, maxSkillPathBytes))
		}
		value.Paths = paths
		seen[value.ID] = true
		result = append(result, value)
	}
	return result, nil
}

// clamp truncates on a rune boundary so a clamped string stays valid UTF-8.
func clamp(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	truncated := value[:limit]
	for len(truncated) > 0 && !utf8.ValidString(truncated) {
		truncated = truncated[:len(truncated)-1]
	}
	return truncated
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
