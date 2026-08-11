package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func validModel() ManagedModel {
	return ManagedModel{
		ID: "qwen3-32b", DisplayName: "Qwen 32B", ModelPath: "Qwen/Qwen3-32B",
		Port: 8001, MaxModelLen: 32768, GPUMemoryUtilization: 0.45, KVCacheDType: KVCacheFP8,
	}
}

func TestManagedModelValidation(t *testing.T) {
	if err := validModel().Validate(); err != nil {
		t.Fatalf("a well-formed model must validate: %v", err)
	}

	cases := map[string]func(*ManagedModel){
		// A served id that starts with a dash would be read by vLLM as a flag.
		"leading dash in id":     func(m *ManagedModel) { m.ID = "-flag" },
		"whitespace in id":       func(m *ManagedModel) { m.ID = "two words" },
		"slash in id":            func(m *ManagedModel) { m.ID = "org/model" },
		"empty id":               func(m *ManagedModel) { m.ID = "" },
		"oversized id":           func(m *ManagedModel) { m.ID = "a" + strings.Repeat("b", 128) },
		"empty display":          func(m *ManagedModel) { m.DisplayName = "  " },
		"newline in display":     func(m *ManagedModel) { m.DisplayName = "Qwen\n32B" },
		"leading dash in path":   func(m *ManagedModel) { m.ModelPath = "--served-model-name" },
		"control char in path":   func(m *ManagedModel) { m.ModelPath = "Qwen/Qwen3\x0032B" },
		"empty path":             func(m *ManagedModel) { m.ModelPath = "" },
		"privileged port":        func(m *ManagedModel) { m.Port = 80 },
		"port out of range":      func(m *ManagedModel) { m.Port = 70000 },
		"tiny context":           func(m *ManagedModel) { m.MaxModelLen = 128 },
		"absurd context":         func(m *ManagedModel) { m.MaxModelLen = MaxMaxModelLen + 1 },
		"zero gpu fraction":      func(m *ManagedModel) { m.GPUMemoryUtilization = 0 },
		"gpu fraction above one": func(m *ManagedModel) { m.GPUMemoryUtilization = 1.5 },
		"unknown kv dtype":       func(m *ManagedModel) { m.KVCacheDType = "q8" },
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

func TestManagedFleetRefusesCollisions(t *testing.T) {
	first := validModel()
	second := validModel()
	second.ID, second.Port = "small", 8002

	if err := ValidateManagedModels([]ManagedModel{first, second}, 8177, 8080); err != nil {
		t.Fatalf("two distinct models must coexist: %v", err)
	}

	duplicate := second
	duplicate.ID = first.ID
	if err := ValidateManagedModels([]ManagedModel{first, duplicate}, 8177, 8080); err == nil {
		t.Fatal("a duplicate served id must be refused")
	}

	sharedPort := second
	sharedPort.Port = first.Port
	if err := ValidateManagedModels([]ManagedModel{first, sharedPort}, 8177, 8080); err == nil {
		t.Fatal("two models cannot share one port")
	}

	onConsole := validModel()
	onConsole.Port = 8177
	if err := ValidateManagedModels([]ManagedModel{onConsole}, 8177, 8080); err == nil {
		t.Fatal("a model must not take Console's own port")
	}
	onVeil := validModel()
	onVeil.Port = 8080
	if err := ValidateManagedModels([]ManagedModel{onVeil}, 8177, 8080); err == nil {
		t.Fatal("a model must not take Veil's own port")
	}
}

func TestModelsEnvJSONMatchesVeilsContract(t *testing.T) {
	if value, err := ModelsEnvJSON(nil); err != nil || value != "" {
		t.Fatalf("no models means no VEIL_MODELS at all: %q %v", value, err)
	}

	reasoning := validModel()
	reasoning.Reasoning = true
	plain := validModel()
	plain.ID, plain.Port, plain.DisplayName = "small", 8002, "Small"

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
		t.Fatalf("the entry must address the model's own loopback port: %#v", first)
	}
	if first["display"] != "Qwen 32B" || first["reasoning"] != true || first["context_length"] != float64(32768) {
		t.Fatalf("registry metadata must travel: %#v", first)
	}
	if entries[1]["reasoning"] != false {
		t.Fatalf("an undeclared model must not claim reasoning: %#v", entries[1])
	}
	// Exactly the five keys Veil's strict parser accepts. An extra one would be
	// refused by a Veil that has never heard of it.
	if len(first) != 5 {
		t.Fatalf("VEIL_MODELS entries carry exactly the contract keys: %#v", first)
	}
}

func TestTotalGPUFractionIsAWarningNumber(t *testing.T) {
	first, second := validModel(), validModel()
	second.GPUMemoryUtilization = 0.6
	if total := TotalGPUFraction([]ManagedModel{first, second}); total < 1.04 || total > 1.06 {
		t.Fatalf("fractions must sum: %v", total)
	}
}
