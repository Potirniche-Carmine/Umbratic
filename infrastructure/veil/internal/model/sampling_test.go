package model

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRegistrySamplingFollowsThinkingAndSendsZeroOverrides(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer server.Close()
	profiles := &SamplingProfiles{
		Thinking:    SamplingProfile{Temperature: 1, TopP: .95, TopK: 20, RepetitionPenalty: 1},
		NonThinking: SamplingProfile{Temperature: .7, TopP: .8, TopK: 20, PresencePenalty: 1.5, RepetitionPenalty: 1},
	}
	registry, err := NewRegistry(ModeServer, "qwen", "", []RegistrySpec{{ID: "qwen", BaseURL: server.URL, Reasoning: true, SamplingProfiles: profiles}}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for _, enabled := range []bool{false, true} {
		response, err := registry.DoChat(context.Background(), ChatRequest{Model: "qwen", Thinking: &enabled, ReasoningEffort: "xhigh", Messages: []Message{{Role: "user", Content: "hello"}}})
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		want := profiles.NonThinking
		if enabled {
			want = profiles.Thinking
		}
		if received["temperature"] != want.Temperature || received["presence_penalty"] != want.PresencePenalty || received["min_p"] != float64(0) || received["repetition_penalty"] != float64(1) {
			t.Fatalf("wrong profile: %#v", received)
		}
		kwargs := received["chat_template_kwargs"].(map[string]any)
		if kwargs["enable_thinking"] != enabled {
			t.Fatalf("wrong mode: %#v", kwargs)
		}
		if enabled && kwargs["reasoning_effort"] != "xhigh" {
			t.Fatal("custom effort was not forwarded")
		}
	}
}

func TestSamplingRejectsInvalidProfiles(t *testing.T) {
	p := SamplingProfiles{Thinking: SamplingProfile{TopP: .95, RepetitionPenalty: 1}, NonThinking: SamplingProfile{TopP: .8, RepetitionPenalty: 1}}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	p.Thinking.MinP = 2
	if p.Validate() == nil {
		t.Fatal("accepted invalid probability")
	}
}
