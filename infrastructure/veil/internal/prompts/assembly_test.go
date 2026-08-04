package prompts

import (
	"strings"
	"testing"

	"umbratic-veil/internal/model"
)

// Prompt assembly is prefix-cache sensitive: reordering these segments changes
// the shared prefix for every request on a deployment. This snapshot pins the
// exact order and role of each assembled segment so a change has to be
// deliberate rather than incidental.
func TestPromptAssemblyOrderIsStable(t *testing.T) {
	skills := []SkillMetadata{{ID: "python"}, {ID: "markdown"}}
	client := []model.Message{{Role: "user", Content: "do the thing"}}
	protected := []model.Message{{Role: "system", Content: "protected turn context"}}

	assembled, err := BuildWithProtectedMessages(EngineeringChat, client, protected, skills)
	if err != nil {
		t.Fatal(err)
	}

	shape := make([]string, 0, len(assembled))
	for _, message := range assembled {
		shape = append(shape, message.Role+":"+segmentName(message))
	}
	want := []string{
		"system:global",
		"system:route",
		"system:skill-catalog",
		"system:protected",
		"user:client",
	}
	if strings.Join(shape, ",") != strings.Join(want, ",") {
		t.Fatalf("prompt assembly order changed:\n got %v\nwant %v", shape, want)
	}

	// The catalog is sorted so two sessions with the same skills produce the
	// same bytes, which is what makes the prefix reusable.
	catalog := assembled[2].Content.(string)
	if strings.Index(catalog, `"id":"markdown"`) > strings.Index(catalog, `"id":"python"`) {
		t.Fatal("skill catalog must be ordered by id")
	}
}

func TestPromptAssemblyOmitsAnEmptySkillCatalog(t *testing.T) {
	assembled, err := BuildWithProtectedMessages(EngineeringChat, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(assembled) != 2 {
		t.Fatalf("expected only the global and route prompts, got %d segments", len(assembled))
	}
}

func segmentName(message model.Message) string {
	content, _ := message.Content.(string)
	switch {
	case content == GlobalSystemPrompt:
		return "global"
	case strings.Contains(content, "skill catalog"):
		return "skill-catalog"
	case content == "protected turn context":
		return "protected"
	case content == "do the thing":
		return "client"
	default:
		return "route"
	}
}
