package config

import (
	"encoding/json"
	"strings"
)

// ModelNameForRole keeps the purpose as the final part of the served name.
func ModelNameForRole(name, role string) string {
	suffix := ""
	switch NormalizeRole(role) {
	case RoleSpeech:
		suffix = "-Dictation"
	case RoleEmbedding:
		suffix = "-Embedding"
	}
	if suffix == "" {
		return name
	}
	for strings.HasSuffix(strings.ToLower(name), "-dictation") || strings.HasSuffix(strings.ToLower(name), "-embedding") {
		name = name[:strings.LastIndex(name, "-")]
	}
	if len(name) > 128-len(suffix) {
		name = name[:128-len(suffix)]
	}
	return name + suffix
}

// Qwen3.8's published profiles also apply to its local MLX quantizations.
// Other models retain their configured server defaults.
func WithLocalModelDefaults(model ManagedModel, path string) ManagedModel {
	name := strings.ToLower(path)
	if NormalizeRole(model.Role) != RoleChat || model.SamplingJSON != "" || !strings.Contains(name, "qwen3.8") || strings.Contains(name, "obliterat") {
		return model
	}
	profiles := SamplingProfiles{
		Thinking:    SamplingProfile{Temperature: 1, TopP: .95, TopK: 20, RepetitionPenalty: 1},
		NonThinking: SamplingProfile{Temperature: .7, TopP: .8, TopK: 20, PresencePenalty: 1.5, RepetitionPenalty: 1},
	}
	encoded, _ := json.MarshalIndent(profiles, "", "  ")
	model.SamplingJSON = string(encoded)
	return model
}
