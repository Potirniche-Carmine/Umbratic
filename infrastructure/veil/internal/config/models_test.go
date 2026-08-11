package config

import (
	"strings"
	"testing"
)

func TestLoadWithoutModelRegistrySynthesizesOneEntry(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_CONTEXT_LENGTH", "65536")
	t.Setenv("VEIL_MODEL_REASONING", "true")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ModelSelectionEnabled {
		t.Fatal("model selection must stay off when VEIL_MODELS is unset")
	}
	if len(cfg.Models) != 1 {
		t.Fatalf("expected one synthesized entry, got %#v", cfg.Models)
	}
	entry := cfg.Models[0]
	if entry.ID != "default-model" || entry.ProviderBaseURL != "http://provider.test" {
		t.Fatalf("synthesized entry must mirror the single-model variables: %#v", entry)
	}
	if !entry.Reasoning || entry.ContextLength != 65536 {
		t.Fatalf("synthesized entry must carry the declared capability and window: %#v", entry)
	}
}

func TestLoadParsesModelRegistry(t *testing.T) {
	setRequiredEnv(t)
	t.Setenv("VEIL_MODELS", `[
		{"id":"default-model","provider_base_url":"http://127.0.0.1:8001/v1","display":"Qwen 32B","reasoning":true,"context_length":98304},
		{"id":"small","provider_base_url":"http://127.0.0.1:8002/v1"}
	]`)

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ModelSelectionEnabled {
		t.Fatal("a configured registry must enable model selection")
	}
	if got := cfg.ModelIDs(); len(got) != 2 || got[0] != "default-model" || got[1] != "small" {
		t.Fatalf("registry order must be preserved: %#v", got)
	}
	entry, ok := cfg.ModelEntryByID("default-model")
	if !ok || entry.Display != "Qwen 32B" || !entry.Reasoning || entry.ContextLength != 98304 {
		t.Fatalf("entry fields must survive parsing: %#v", entry)
	}
	if _, ok := cfg.ModelEntryByID("absent"); ok {
		t.Fatal("an unregistered id must not resolve")
	}
}

func TestLoadRejectsBadModelRegistries(t *testing.T) {
	cases := map[string]struct {
		mode   string
		models string
		want   string
	}{
		"not an array": {
			models: `{"id":"default-model"}`,
			want:   "JSON array",
		},
		"empty array": {
			models: `[]`,
			want:   "at least one model",
		},
		"missing id": {
			models: `[{"provider_base_url":"http://127.0.0.1:8001/v1"}]`,
			want:   "missing id",
		},
		"duplicate id": {
			models: `[{"id":"default-model","provider_base_url":"http://127.0.0.1:8001/v1"},{"id":"default-model","provider_base_url":"http://127.0.0.1:8002/v1"}]`,
			want:   "twice",
		},
		"oversized id": {
			models: `[{"id":"` + strings.Repeat("m", MaxModelIDBytes+1) + `","provider_base_url":"http://127.0.0.1:8001/v1"}]`,
			want:   "longer than",
		},
		"missing base url": {
			models: `[{"id":"default-model"}]`,
			want:   "missing provider_base_url",
		},
		"non http base url": {
			models: `[{"id":"default-model","provider_base_url":"file:///etc/passwd"}]`,
			want:   "invalid provider_base_url",
		},
		"default not in registry": {
			models: `[{"id":"other","provider_base_url":"http://127.0.0.1:8001/v1"}]`,
			want:   "VEIL_MODEL must name",
		},
		"unknown entry field": {
			models: `[{"id":"default-model","provider_base_url":"http://127.0.0.1:8001/v1","kv_cache":"fp8"}]`,
			want:   "JSON array",
		},
		"local mode": {
			mode:   "local",
			models: `[{"id":"default-model","provider_base_url":"http://127.0.0.1:8001/v1"}]`,
			want:   "server-mode setting",
		},
	}

	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			setRequiredEnv(t)
			if testCase.mode != "" {
				t.Setenv("VEIL_MODE", testCase.mode)
				t.Setenv("VEIL_PROVIDER_BASE_URL", "http://127.0.0.1:11434")
			}
			t.Setenv("VEIL_MODELS", testCase.models)
			_, err := Load()
			if err == nil {
				t.Fatal("expected a configuration error")
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error %q must explain %q", err, testCase.want)
			}
		})
	}
}
