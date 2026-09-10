package config

import (
	"encoding/json"
	"strings"
	"testing"
)

const validCommand = "serve Qwen/Qwen3-32B --host 127.0.0.1 --port 8001 --served-model-name qwen3-32b --max-model-len 32768 --gpu-memory-utilization 0.45 --kv-cache-dtype fp8"

func validModel() ManagedModel {
	return ManagedModel{ID: "qwen3-32b", Command: validCommand}
}

func TestManagedModelValidation(t *testing.T) {
	if err := validModel().Validate(); err != nil {
		t.Fatalf("a well-formed model must validate: %v", err)
	}

	cases := map[string]func(*ManagedModel){
		// A served id that starts with a dash would be read by vLLM as a flag.
		"leading dash in id": func(m *ManagedModel) { m.ID = "-flag" },
		"whitespace in id":   func(m *ManagedModel) { m.ID = "two words" },
		"slash in id":        func(m *ManagedModel) { m.ID = "org/model" },
		"empty id":           func(m *ManagedModel) { m.ID = "" },
		"oversized id":       func(m *ManagedModel) { m.ID = "a" + strings.Repeat("b", 128) },
		"empty command":      func(m *ManagedModel) { m.Command = "  " },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			model := validModel()
			mutate(&model)
			if err := model.Validate(); err == nil {
				t.Fatal("expected the field to be refused")
			}
		})
	}
}

// The command is an argument list, not a shell command. Nothing here can become
// a second process, a redirection, or a substitution — Console never invokes a
// shell, and refusing the characters outright is what keeps that true.
func TestCommandRefusesShellConstructs(t *testing.T) {
	for name, command := range map[string]string{
		"command chaining":      validCommand + " ; rm -rf /",
		"backgrounding":         validCommand + " & curl evil.test",
		"piping":                validCommand + " | sh",
		"output redirection":    validCommand + " > /etc/passwd",
		"input redirection":     validCommand + " < /etc/shadow",
		"dollar substitution":   validCommand + " --seed $(id -u)",
		"backtick substitution": validCommand + " --seed `id -u`",
		"null byte":             validCommand + " \x00",
	} {
		t.Run(name, func(t *testing.T) {
			model := validModel()
			model.Command = command
			err := model.Validate()
			if err == nil {
				facts, _ := model.Parse()
				t.Fatalf("this must never become argv: %#v", facts.Args)
			}
			if name != "null byte" && !strings.Contains(err.Error(), "not allowed") {
				t.Fatalf("wanted a shell-character refusal, got %v", err)
			}
		})
	}
}

func TestCommandRequiresWhatVeilNeeds(t *testing.T) {
	for name, testCase := range map[string]struct{ command, want string }{
		"missing serve":      {"Qwen/Qwen3-32B --port 8001 --served-model-name qwen3-32b", "must start with `serve`"},
		"flag before model":  {"serve --port 8001 --served-model-name qwen3-32b", "before any flag"},
		"missing port":       {"serve Qwen/Qwen3-32B --served-model-name qwen3-32b", "must set --port"},
		"missing served id":  {"serve Qwen/Qwen3-32B --port 8001", "must set --served-model-name"},
		"served id mismatch": {"serve Qwen/Qwen3-32B --port 8001 --served-model-name other", "must stay"},
		"port not a number":  {"serve Qwen/Qwen3-32B --port eighty --served-model-name qwen3-32b", "--port must be a number"},
		"privileged port":    {"serve Qwen/Qwen3-32B --port 80 --served-model-name qwen3-32b", "--port must be between"},
		"tiny context":       {"serve Qwen/Qwen3-32B --port 8001 --served-model-name qwen3-32b --max-model-len 8", "--max-model-len must be between"},
		"unclosed quote":     {`serve "Qwen/Qwen3-32B --port 8001 --served-model-name qwen3-32b`, "unclosed quote"},
	} {
		t.Run(name, func(t *testing.T) {
			model := validModel()
			model.Command = testCase.command
			err := model.Validate()
			if err == nil {
				t.Fatal("expected the command to be refused")
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error %q must explain %q", err, testCase.want)
			}
		})
	}
}

// Arguments are written one per line, so a newline is whitespace to the
// tokenizer — not a second command, because there is no shell to give it that
// meaning.
func TestNewlinesSeparateArgumentsRatherThanCommands(t *testing.T) {
	model := validModel()
	model.Command = strings.Join([]string{
		"serve Qwen/Qwen3-32B",
		"--port 8001",
		"--served-model-name qwen3-32b",
		"--max-model-len 32768",
	}, "\n")
	facts, err := model.Parse()
	if err != nil {
		t.Fatal(err)
	}
	if facts.Port != 8001 || facts.MaxModelLen != 32768 {
		t.Fatalf("a multi-line command must parse: %#v", facts)
	}
	if len(facts.Args) != 8 {
		t.Fatalf("newlines separate arguments, nothing more: %#v", facts.Args)
	}
}

// Saving lays the arguments out one flag per line, so a pasted one-liner comes
// back readable instead of staying a wall of text.
func TestFormatCommandPutsOneFlagPerLine(t *testing.T) {
	facts, err := validModel().Parse()
	if err != nil {
		t.Fatal(err)
	}
	got := FormatCommand(facts.Args)
	want := strings.Join([]string{
		"serve Qwen/Qwen3-32B",
		"--host 127.0.0.1",
		"--port 8001",
		"--served-model-name qwen3-32b",
		"--max-model-len 32768",
		"--gpu-memory-utilization 0.45",
		"--kv-cache-dtype fp8",
	}, "\n")
	if got != want {
		t.Fatalf("layout changed:\n%s\n---\n%s", got, want)
	}

	// A bare switch keeps its own line, and a value with a space keeps quotes
	// so the next read still sees one argument.
	got = FormatCommand([]string{"serve", "/models/Qwen 32B", "--enforce-eager", "--port", "8001"})
	want = strings.Join([]string{`serve "/models/Qwen 32B"`, "--enforce-eager", "--port 8001"}, "\n")
	if got != want {
		t.Fatalf("layout changed:\n%s\n---\n%s", got, want)
	}

	// And what it writes, it can read back.
	round := ManagedModel{ID: "qwen3-32b", Command: FormatCommand(facts.Args)}
	if err := round.Validate(); err != nil {
		t.Fatalf("a formatted command must parse again: %v", err)
	}
}

func TestCommandParsesIntoArgvAndFacts(t *testing.T) {
	facts, err := validModel().Parse()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"serve", "Qwen/Qwen3-32B",
		"--host", "127.0.0.1",
		"--port", "8001",
		"--served-model-name", "qwen3-32b",
		"--max-model-len", "32768",
		"--gpu-memory-utilization", "0.45",
		"--kv-cache-dtype", "fp8",
	}
	if len(facts.Args) != len(want) {
		t.Fatalf("argv shape changed: %#v", facts.Args)
	}
	for index := range want {
		if facts.Args[index] != want[index] {
			t.Fatalf("argv[%d] = %q, want %q", index, facts.Args[index], want[index])
		}
	}
	if facts.Port != 8001 || facts.MaxModelLen != 32768 || facts.ModelPath != "Qwen/Qwen3-32B" {
		t.Fatalf("the facts Veil needs must be read from the command: %#v", facts)
	}
}

// A quote groups a token and does nothing else — no expansion, no escapes.
func TestQuotesGroupAndNothingMore(t *testing.T) {
	model := validModel()
	model.Command = `serve "/models/Qwen 32B" --port 8001 --served-model-name qwen3-32b`
	facts, err := model.Parse()
	if err != nil {
		t.Fatal(err)
	}
	if facts.ModelPath != "/models/Qwen 32B" {
		t.Fatalf("a quoted path must stay one argument: %#v", facts.Args)
	}
}

// --flag=value is as common as --flag value, and the port has to be found
// either way or Veil is pointed at nothing.
func TestNamedValuesAreFoundInEitherForm(t *testing.T) {
	model := validModel()
	model.Command = "serve Qwen/Qwen3-32B --port=8042 --served-model-name=qwen3-32b --max-model-len=65536"
	facts, err := model.Parse()
	if err != nil {
		t.Fatal(err)
	}
	if facts.Port != 8042 || facts.MaxModelLen != 65536 {
		t.Fatalf("--flag=value must be read: %#v", facts)
	}
}

func TestCommandIsBounded(t *testing.T) {
	model := validModel()
	model.Command = validCommand + strings.Repeat(" --extra", 200)
	if err := model.Validate(); err == nil {
		t.Fatal("an unbounded argument list must be refused")
	}
	model.Command = "serve " + strings.Repeat("m", 600) + " --port 8001 --served-model-name qwen3-32b"
	if err := model.Validate(); err == nil {
		t.Fatal("an unbounded single argument must be refused")
	}
}

func TestManagedFleetRefusesCollisions(t *testing.T) {
	first := validModel()
	second := ManagedModel{
		ID:      "small",
		Command: "serve Qwen/Qwen3-4B --port 8002 --served-model-name small",
	}

	if err := ValidateManagedModels([]ManagedModel{first, second}, 8177, 8080); err != nil {
		t.Fatalf("two distinct models must coexist: %v", err)
	}

	duplicate := second
	duplicate.ID, duplicate.Command = first.ID, first.Command
	if err := ValidateManagedModels([]ManagedModel{first, duplicate}, 8177, 8080); err == nil {
		t.Fatal("a duplicate served id must be refused")
	}

	sharedPort := ManagedModel{
		ID:      "small",
		Command: "serve Qwen/Qwen3-4B --port 8001 --served-model-name small",
	}
	if err := ValidateManagedModels([]ManagedModel{first, sharedPort}, 8177, 8080); err == nil {
		t.Fatal("two models cannot share one port")
	}

	onConsole := ManagedModel{ID: "c", Command: "serve m --port 8177 --served-model-name c"}
	if err := ValidateManagedModels([]ManagedModel{onConsole}, 8177, 8080); err == nil {
		t.Fatal("a model must not take Console's own port")
	}
	onVeil := ManagedModel{ID: "v", Command: "serve m --port 8080 --served-model-name v"}
	if err := ValidateManagedModels([]ManagedModel{onVeil}, 8177, 8080); err == nil {
		t.Fatal("a model must not take Veil's own port")
	}
}

func TestModelsEnvJSONMatchesVeilsContract(t *testing.T) {
	if value, err := ModelsEnvJSON(nil); err != nil || value != "" {
		t.Fatalf("no models means no VEIL_MODELS at all: %q %v", value, err)
	}

	reasoning := validModel()
	reasoning.ReasoningEfforts = "off,on"
	plain := ManagedModel{
		ID:      "small",
		Command: "serve Qwen/Qwen3-4B --port 8002 --served-model-name small --max-model-len 32768",
	}

	value, err := ModelsEnvJSON([]ManagedModel{reasoning, plain})
	if err != nil {
		t.Fatal(err)
	}
	var entries []map[string]any
	if err := json.Unmarshal([]byte(value), &entries); err != nil {
		t.Fatalf("VEIL_MODELS must be a JSON array: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("every registered model travels: %#v", entries)
	}
	first := entries[0]
	if first["id"] != "qwen3-32b" || first["provider_base_url"] != "http://127.0.0.1:8001/v1" {
		t.Fatalf("the entry must address the port the command sets: %#v", first)
	}
	if first["display"] != "qwen3-32b" || first["context_length"] != float64(32768) {
		t.Fatalf("registry metadata must travel: %#v", first)
	}
	// Console does not guess whether a model thinks: the chat-template kwarg
	// that controls it is named differently per family, so the administrator
	// sets it in the command and the client may still override per request.
	if entries[0]["reasoning"] != true || entries[1]["reasoning"] != false {
		t.Fatalf("managed models leave the thinking choice to the command and the client: %#v", entries)
	}
	// Exactly the five keys Veil's strict parser accepts.
	if len(first) != 6 {
		t.Fatalf("VEIL_MODELS entries carry exactly the contract keys: %#v", first)
	}
}

func TestDefaultCommandIsValidForANewModel(t *testing.T) {
	model := ManagedModel{
		ID:      "new-model",
		Command: DefaultCommand("org/weights", "new-model", 8003),
	}
	if err := model.Validate(); err != nil {
		t.Fatalf("the prefilled command must be ready to save: %v", err)
	}
	if model.Port() != 8003 {
		t.Fatalf("the suggested port must reach the command: %d", model.Port())
	}
	if strings.Contains(model.Command, "--kv-cache-dtype") || strings.Contains(model.Command, "--gpu-memory-utilization") {
		t.Fatalf("new models must leave precision and allocation to the runtime profile: %q", model.Command)
	}
}

func speechModel() ManagedModel {
	return ManagedModel{
		ID:      "qwen3-asr",
		Command: "serve Qwen/Qwen3-ASR-1.7B --port 8010 --served-model-name qwen3-asr",
		Role:    RoleSpeech,
	}
}

// The dictation runtime answers /v1/audio/transcriptions, not chat. Listing it
// in VEIL_MODELS would put a model in the client's picker that fails every
// message sent to it.
func TestSpeechModelsStayOutOfTheChatRegistry(t *testing.T) {
	value, err := ModelsEnvJSON([]ManagedModel{validModel(), speechModel()})
	if err != nil {
		t.Fatal(err)
	}
	var entries []map[string]any
	if err := json.Unmarshal([]byte(value), &entries); err != nil {
		t.Fatalf("VEIL_MODELS must be a JSON array: %v", err)
	}
	if len(entries) != 1 || entries[0]["id"] != "qwen3-32b" {
		t.Fatalf("only chat models are published: %#v", entries)
	}

	// A deployment whose only model is the speech one publishes no registry at
	// all, so Veil keeps its single-model behavior instead of advertising
	// selection over an empty list.
	onlySpeech, err := ModelsEnvJSON([]ManagedModel{speechModel()})
	if err != nil || onlySpeech != "" {
		t.Fatalf("a speech-only fleet means no VEIL_MODELS: %q %v", onlySpeech, err)
	}
}

func TestSpeechEnvironmentAddressesTheRuntimeItSupervises(t *testing.T) {
	if env := SpeechEnvironment([]ManagedModel{validModel()}); len(env) != 0 {
		t.Fatalf("no speech model means dictation stays off: %#v", env)
	}

	env := SpeechEnvironment([]ManagedModel{validModel(), speechModel()})
	want := []string{
		"VEIL_SPEECH_BASE_URL=http://127.0.0.1:8010/v1",
		"VEIL_SPEECH_MODEL=qwen3-asr",
	}
	if len(env) != len(want) {
		t.Fatalf("both variables travel together or neither does: %#v", env)
	}
	for index := range want {
		if env[index] != want[index] {
			t.Fatalf("expected %q, got %q", want[index], env[index])
		}
	}
}

func TestOnlyOneModelMayBeTheDictationRuntime(t *testing.T) {
	second := speechModel()
	second.ID = "whisper"
	second.Command = "serve openai/whisper-large-v3 --port 8011 --served-model-name whisper"

	if err := ValidateManagedModels([]ManagedModel{speechModel(), second}, 8177, 8080); err == nil {
		t.Fatal("Veil takes one speech endpoint, so a second must be refused at save time")
	}
	if err := ValidateManagedModels([]ManagedModel{validModel(), speechModel()}, 8177, 8080); err != nil {
		t.Fatalf("one chat model beside one speech model is the normal deployment: %v", err)
	}
}
