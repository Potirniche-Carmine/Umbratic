package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ManagedModel is one vLLM process Console launches and supervises.
//
// Command is the argument list, and it is the single source of truth: the port
// Veil reaches this model on and the context window it publishes are read back
// out of it rather than stored twice and allowed to drift.
//
// It is an argument list, not a shell command. Console builds argv from it and
// executes the vLLM binary directly — there is no shell, no expansion, and no
// metacharacter has any meaning. Everything the security boundary says about
// not adding a command runner still holds; what an administrator can choose
// here is which flags vLLM is started with.
type ManagedModel struct {
	// ID is the served model name — what a client sends as `model`, what
	// `/v1/models` reports, and what `--served-model-name` must say.
	ID               string
	Command          string
	ReasoningEfforts string
	SamplingJSON     string
	// Role decides which Veil setting this process feeds. Both roles are the
	// same kind of child — one vLLM serving one model on one loopback port —
	// but a transcription runtime answers /v1/audio/transcriptions rather than
	// /v1/chat/completions, so putting it in the chat registry would publish a
	// model that fails every request a client could send it.
	Role    string
	Enabled bool
}

const (
	// RoleChat is the default and what every model registered before this
	// column existed is.
	RoleChat = "chat"
	// RoleSpeech is the transcription runtime that backs dictation. Veil takes
	// one speech endpoint, so at most one model may hold this role.
	RoleSpeech    = "speech"
	RoleEmbedding = "embedding"
)

// IsSpeech reports whether this model backs dictation rather than chat.
func (m ManagedModel) IsSpeech() bool { return NormalizeRole(m.Role) == RoleSpeech }

// NormalizeRole maps an empty or unknown role onto chat. The value arrives from
// a form, and a typo must not silently promote a model into the speech slot.
func NormalizeRole(value string) string {
	if strings.TrimSpace(value) == RoleEmbedding {
		return RoleEmbedding
	}
	if strings.TrimSpace(value) == RoleSpeech {
		return RoleSpeech
	}
	return RoleChat
}

const (
	KVCacheFP8  = "fp8"
	KVCacheAuto = "auto"
	// MinManagedPort and MaxManagedPort bound the loopback ports Console will
	// bind a runtime to. Below 1024 is privileged.
	MinManagedPort = 1024
	MaxManagedPort = 65535
	// SuggestedPortStart is where a new model's port suggestion begins.
	SuggestedPortStart = 8001
	SuggestedPortEnd   = 8099
	MinMaxModelLen     = 1024
	MaxMaxModelLen     = 1_048_576

	maxCommandBytes  = 4096
	maxCommandTokens = 64
	maxTokenBytes    = 512
)

// A served id travels in URLs, in argv, and in a JSON environment variable. The
// leading-character rule matters most: an id starting with `-` would be read by
// vLLM as a flag rather than a value.
var managedModelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// shellMetacharacters are refused outright. None of them mean anything to argv
// — Console never invokes a shell — but refusing them is what keeps that true
// no matter how this command is later handled, and none belong in a vLLM flag.
//
// A newline is not one of them. Arguments are written one per line for the same
// reason a compose file is: a wall of flags on one line is unreadable. To the
// tokenizer a newline is whitespace, exactly like a space.
const shellMetacharacters = ";&|<>$`"

// DefaultCommand leaves precision and cache dtype to the selected runtime.
func DefaultCommand(modelPath, servedID string, port int) string {
	if strings.TrimSpace(modelPath) == "" {
		modelPath = "org/model"
	}
	if strings.TrimSpace(servedID) == "" {
		servedID = "model-id"
	}
	return FormatCommand([]string{
		"serve", modelPath,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(port),
		"--served-model-name", servedID,
		"--max-model-len", "16384",
	})
}

// FormatCommand lays an argument list out one flag per line, with each flag's
// value beside it. `serve <model>` leads, because that is the one positional
// pair and it is what the model actually is.
//
// Saving normalizes through this, so a pasted one-liner comes back readable
// rather than staying a wall of text.
func FormatCommand(args []string) string {
	if len(args) == 0 {
		return ""
	}
	var lines []string
	index := 0
	if args[0] == "serve" && len(args) > 1 {
		lines = append(lines, quoteIfNeeded(args[0])+" "+quoteIfNeeded(args[1]))
		index = 2
	}
	for index < len(args) {
		token := args[index]
		// A flag takes the next token as its value unless that token is itself
		// a flag, in which case this one is a bare switch.
		if strings.HasPrefix(token, "-") && index+1 < len(args) && !strings.HasPrefix(args[index+1], "-") {
			lines = append(lines, quoteIfNeeded(token)+" "+quoteIfNeeded(args[index+1]))
			index += 2
			continue
		}
		lines = append(lines, quoteIfNeeded(token))
		index++
	}
	return strings.Join(lines, "\n")
}

// quoteIfNeeded preserves whitespace and literal quotes on the next read.
func quoteIfNeeded(token string) string {
	if token == "" {
		return `""`
	}
	if !strings.ContainsAny(token, " \t\n\r'\"") {
		return token
	}
	// A JSON value is the common case here, so single quotes are the ones that
	// survive: wrapping `{"enable_thinking": false}` in double quotes would end
	// the quote on its first inner one.
	if strings.Contains(token, `"`) {
		return `'` + strings.ReplaceAll(token, `'`, `'"'"'`) + `'`
	}
	return `"` + token + `"`
}

// CommandFacts is what Console reads back out of a command: the arguments to
// execute, and the two values Veil's registry is built from.
type CommandFacts struct {
	Args        []string
	ModelPath   string
	Port        int
	MaxModelLen int
}

// splitCommand tokenizes on whitespace, honouring single and double quotes for
// grouping only. No escapes, no variables, no globbing — a quote groups, and
// that is all it does.
func splitCommand(command string) ([]string, error) {
	var tokens []string
	var current strings.Builder
	quote := rune(0)
	started := false
	for _, character := range command {
		switch {
		case quote != 0 && character == quote:
			quote = 0
		case quote == 0 && (character == '\'' || character == '"'):
			quote = character
			started = true
		case quote == 0 && (character == ' ' || character == '\t' || character == '\n' || character == '\r'):
			if started {
				tokens = append(tokens, current.String())
				current.Reset()
				started = false
			}
		default:
			current.WriteRune(character)
			started = true
		}
	}
	if quote != 0 {
		return nil, errors.New("the command has an unclosed quote")
	}
	if started {
		tokens = append(tokens, current.String())
	}
	return tokens, nil
}

func namedValue(tokens []string, flag string) (string, bool) {
	for index, token := range tokens {
		if token == flag && index+1 < len(tokens) {
			return tokens[index+1], true
		}
		if value, found := strings.CutPrefix(token, flag+"="); found {
			return value, true
		}
	}
	return "", false
}

// Parse validates the command and reads the facts Veil needs from it.
func (m ManagedModel) Parse() (CommandFacts, error) {
	command := strings.TrimSpace(m.Command)
	if command == "" {
		return CommandFacts{}, errors.New("the command is required")
	}
	if len(command) > maxCommandBytes {
		return CommandFacts{}, fmt.Errorf("the command must be %d characters or fewer", maxCommandBytes)
	}
	if index := strings.IndexAny(command, shellMetacharacters); index >= 0 {
		return CommandFacts{}, fmt.Errorf(
			"%q is not allowed: this is an argument list, not a shell command", string(command[index]))
	}
	for _, character := range command {
		if character == '\n' || character == '\r' || character == '\t' {
			continue
		}
		if character < 0x20 || character == 0x7f {
			return CommandFacts{}, errors.New("the command must not contain control characters")
		}
	}
	tokens, err := splitCommand(command)
	if err != nil {
		return CommandFacts{}, err
	}
	if len(tokens) > maxCommandTokens {
		return CommandFacts{}, fmt.Errorf("the command must have %d arguments or fewer", maxCommandTokens)
	}
	for _, token := range tokens {
		if len(token) > maxTokenBytes {
			return CommandFacts{}, fmt.Errorf("argument %q is longer than %d characters", clampToken(token), maxTokenBytes)
		}
	}
	if len(tokens) < 2 || tokens[0] != "serve" {
		return CommandFacts{}, errors.New("the command must start with `serve` followed by the model")
	}
	modelPath := tokens[1]
	if strings.HasPrefix(modelPath, "-") {
		return CommandFacts{}, errors.New("the model must follow `serve` directly, before any flag")
	}

	served, ok := namedValue(tokens, "--served-model-name")
	if !ok {
		return CommandFacts{}, errors.New("the command must set --served-model-name")
	}
	if served != m.ID {
		return CommandFacts{}, fmt.Errorf(
			"--served-model-name must stay %q; clients already use that name, so changing it is a remove and an add", m.ID)
	}

	rawPort, ok := namedValue(tokens, "--port")
	if !ok {
		return CommandFacts{}, errors.New("the command must set --port so Veil knows where to reach this model")
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		return CommandFacts{}, errors.New("--port must be a number")
	}
	if port < MinManagedPort || port > MaxManagedPort {
		return CommandFacts{}, fmt.Errorf("--port must be between %d and %d", MinManagedPort, MaxManagedPort)
	}

	facts := CommandFacts{Args: tokens, ModelPath: modelPath, Port: port}
	if rawLength, present := namedValue(tokens, "--max-model-len"); present {
		length, err := strconv.Atoi(rawLength)
		if err != nil {
			return CommandFacts{}, errors.New("--max-model-len must be a number")
		}
		if length < MinMaxModelLen || length > MaxMaxModelLen {
			return CommandFacts{}, fmt.Errorf("--max-model-len must be between %d and %d", MinMaxModelLen, MaxMaxModelLen)
		}
		facts.MaxModelLen = length
	}
	return facts, nil
}

func clampToken(token string) string {
	if len(token) <= 40 {
		return token
	}
	return token[:40] + "…"
}

func (m ManagedModel) Validate() error {
	if _, err := m.Sampling(); err != nil {
		return err
	}
	if m.SamplingJSON != "" && NormalizeRole(m.Role) != RoleChat {
		return errors.New("sampling settings require a chat model")
	}
	seen := map[string]bool{}
	for _, effort := range m.Efforts() {
		if !supportedEffort(effort) || seen[effort] || NormalizeRole(m.Role) != RoleChat {
			return errors.New("choose distinct chat reasoning options: on, off, low, medium, high, xhigh, max")
		}
		seen[effort] = true
	}
	if !managedModelID.MatchString(m.ID) {
		return errors.New("model name must be at most 128 characters, start with a letter or digit, and use only letters, digits, dots, dashes, or underscores")
	}
	_, err := m.Parse()
	return err
}

// Port is the loopback port this model serves on, or 0 when the command does
// not parse. Callers that need the error use Parse.
func (m ManagedModel) Port() int {
	facts, err := m.Parse()
	if err != nil {
		return 0
	}
	return facts.Port
}

// ValidateManagedModels checks one model against the rest of the fleet and
// against the two ports Console already owns. A duplicate id or a shared port
// is a configuration that cannot start, so it is refused at the form.
func ValidateManagedModels(models []ManagedModel, consolePort, veilPort int) error {
	seenID := map[string]bool{}
	seenPort := map[int]bool{}
	speechModels := 0
	for _, model := range models {
		if NormalizeRole(model.Role) == RoleSpeech {
			speechModels++
			if speechModels > 1 {
				return errors.New("only one model can be the dictation runtime")
			}
		}
		facts, err := model.Parse()
		if err != nil {
			return fmt.Errorf("model %q: %w", model.ID, err)
		}
		if err := model.Validate(); err != nil {
			return fmt.Errorf("model %q: %w", model.ID, err)
		}
		if seenID[model.ID] {
			return fmt.Errorf("model id %q is already registered", model.ID)
		}
		seenID[model.ID] = true
		if seenPort[facts.Port] {
			return fmt.Errorf("port %d is already used by another model", facts.Port)
		}
		seenPort[facts.Port] = true
		if facts.Port == consolePort || facts.Port == veilPort {
			return fmt.Errorf("port %d is already used by Console or Veil", facts.Port)
		}
	}
	return nil
}

// ProviderBaseURL is the address Veil reaches this model on. Always loopback:
// Console supervises the process on this machine, and Veil's own dialer refuses
// anything that is not loopback or private.
func (m ManagedModel) ProviderBaseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/v1", m.Port())
}

// modelEnvEntry is the exact shape Veil's VEIL_MODELS parser accepts. It is
// declared here rather than shared through a package because Console and Veil
// are released separately: the contract is the JSON, not a Go type.
type modelEnvEntry struct {
	ID               string            `json:"id"`
	ProviderBaseURL  string            `json:"provider_base_url"`
	Display          string            `json:"display"`
	Reasoning        bool              `json:"reasoning"`
	ReasoningEfforts []string          `json:"reasoning_efforts"`
	SamplingProfiles *SamplingProfiles `json:"sampling_profiles,omitempty"`
	ContextLength    int               `json:"context_length"`
}

// ModelsEnvJSON renders VEIL_MODELS. Empty when there are no chat models, so
// Veil keeps its single-model behavior and never advertises model selection.
//
// The speech model is deliberately absent: it answers transcription requests,
// not chat, and listing it would put a model in the picker that fails every
// message sent to it.
func ModelsEnvJSON(models []ManagedModel) (string, error) {
	entries := make([]modelEnvEntry, 0, len(models))
	for _, model := range models {
		if NormalizeRole(model.Role) != RoleChat {
			continue
		}
		facts, err := model.Parse()
		if err != nil {
			return "", err
		}
		sampling, err := model.Sampling()
		if err != nil {
			return "", err
		}
		entries = append(entries, modelEnvEntry{
			SamplingProfiles: sampling,
			ID:               model.ID,
			ProviderBaseURL:  fmt.Sprintf("http://127.0.0.1:%d/v1", facts.Port),
			Display:          model.ID,
			Reasoning:        len(model.Efforts()) > 0,
			ReasoningEfforts: model.Efforts(),
			ContextLength:    facts.MaxModelLen,
		})
	}
	if len(entries) == 0 {
		return "", nil
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// SpeechEnvironment renders the two variables that turn dictation on in Veil.
// Empty when no model holds the speech role, which is what keeps
// /api/transcribe absent and the feature name unadvertised rather than
// advertising a capability with nothing behind it.
func SpeechEnvironment(models []ManagedModel) []string {
	for _, model := range models {
		if NormalizeRole(model.Role) != RoleSpeech {
			continue
		}
		facts, err := model.Parse()
		if err != nil {
			return nil
		}
		return []string{
			fmt.Sprintf("VEIL_SPEECH_BASE_URL=http://127.0.0.1:%d/v1", facts.Port),
			"VEIL_SPEECH_MODEL=" + model.ID,
		}
	}
	return nil
}
