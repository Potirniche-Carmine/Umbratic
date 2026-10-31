package config

import (
	"strings"
	"testing"
)

func TestReasoningOptionsAreClosed(t *testing.T) {
	model := validModel()
	model.ReasoningEfforts = "on,off,low,medium,high,xhigh,max"
	if err := model.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, effort := range []string{"ultra", "custom", "none", "max,max", "HIGH", "off,on,low,medium,high,xhigh,max,extra"} {
		model.ReasoningEfforts = effort
		if model.Validate() == nil {
			t.Fatalf("accepted %q", effort)
		}
	}
}

func TestModelPurposeIsTheFinalNamePart(t *testing.T) {
	for _, tc := range []struct{ name, role, want string }{
		{"Qwen0.6B", RoleSpeech, "Qwen0.6B-Dictation"},
		{"Qwen0.6B-dictation", RoleSpeech, "Qwen0.6B-Dictation"},
		{"Qwen0.6B-Dictation-Embedding", RoleSpeech, "Qwen0.6B-Dictation"},
		{"Qwen0.6B", RoleEmbedding, "Qwen0.6B-Embedding"},
		{"Qwen27B", RoleChat, "Qwen27B"},
		{strings.Repeat("q", 128), RoleEmbedding, strings.Repeat("q", 118) + "-Embedding"},
	} {
		if got := ModelNameForRole(tc.name, tc.role); got != tc.want {
			t.Fatalf("%s: %q, want %q", tc.role, got, tc.want)
		}
	}
}

func TestLocalQwenSamplingDefaults(t *testing.T) {
	model := WithLocalModelDefaults(validModel(), "/models/Qwen3.8-27B-MLX-4bit/snapshots/main")
	profiles, err := model.Sampling()
	if err != nil || profiles == nil {
		t.Fatalf("missing Qwen profiles: %v", err)
	}
	if profiles.Thinking != (SamplingProfile{Temperature: 1, TopP: .95, TopK: 20, RepetitionPenalty: 1}) || profiles.NonThinking != (SamplingProfile{Temperature: .7, TopP: .8, TopK: 20, PresencePenalty: 1.5, RepetitionPenalty: 1}) {
		t.Fatalf("wrong profiles: %+v", profiles)
	}
	custom := model
	custom.SamplingJSON = strings.ReplaceAll(model.SamplingJSON, "0.95", "0.9")
	if got := WithLocalModelDefaults(custom, "/models/Qwen3.8-27B"); got.SamplingJSON != custom.SamplingJSON {
		t.Fatal("changed administrator's sampling")
	}
	for _, path := range []string{"/models/other", "/models/Qwen3.8-27B-OBLITERATED"} {
		if got := WithLocalModelDefaults(validModel(), path); got.SamplingJSON != "" {
			t.Fatal("applied Qwen profiles to a different checkpoint")
		}
	}
}
