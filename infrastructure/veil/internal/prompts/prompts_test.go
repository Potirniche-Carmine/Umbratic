package prompts

import (
	"strings"
	"testing"

	"umbratic-veil/internal/model"
)

func TestBuildAddsGlobalAndRoutePrompts(t *testing.T) {
	messages, err := Build(EngineeringChat, []model.Message{{Role: "user", Content: "Help me test this."}})
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 3 {
		t.Fatalf("got %d messages, want 3", len(messages))
	}
	if messages[0].Role != "system" || messages[0].Content != GlobalSystemPrompt {
		t.Fatal("first message should be the global system prompt")
	}
	routePrompt, _ := RoutePrompt(EngineeringChat)
	if messages[1].Role != "system" || messages[1].Content != routePrompt {
		t.Fatal("second message should be the route system prompt")
	}
	if messages[2].Role != "user" {
		t.Fatal("client message should follow server prompts")
	}
}

func TestGlobalAndEngineeringPromptsKeepGeneralScope(t *testing.T) {
	global := strings.ToLower(GlobalSystemPrompt)
	for _, want := range []string{"umbratic", "general-purpose", "software and non-software", "workspace preview", "file-changing tool", "stop using tools", "materially different correction"} {
		if !strings.Contains(global, want) {
			t.Fatalf("global prompt missing %q: %q", want, GlobalSystemPrompt)
		}
	}
	route, _ := RoutePrompt(EngineeringChat)
	if !strings.Contains(strings.ToLower(route), "does not make you software-only") {
		t.Fatalf("engineering route should preserve general scope: %q", route)
	}
	for _, blocked := range []string{"do not start visible thinking", "do not paste the full code"} {
		if strings.Contains(global, blocked) || strings.Contains(strings.ToLower(route), blocked) {
			t.Fatalf("prompt retained restrictive client wording %q", blocked)
		}
	}
}

func TestBuildAddsOptionalSkillCatalogAndRequiresCompleteReadBeforeUse(t *testing.T) {
	skills := []SkillMetadata{
		{ID: "python", Name: "Python", Description: "Use for Python work.", Source: "system"},
		{ID: "deal-review", Name: "Deal Review", Description: "Use for account reviews.", Source: "local"},
	}
	messages, err := BuildWithProtectedMessages(EngineeringChat, []model.Message{{Role: "user", Content: "Fix tests."}}, nil, skills)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 4 {
		t.Fatalf("got %d messages, want 4", len(messages))
	}
	prompt, ok := messages[2].Content.(string)
	if !ok {
		t.Fatalf("skill prompt should be text: %#v", messages[2])
	}
	for _, want := range []string{
		"optional task-specific playbooks",
		"not an exhaustive capability list",
		"If no skill would materially help, handle the request normally",
		"Do not describe your general capabilities by enumerating enabled skills",
		"Consider relevant skills when they are likely to improve the result",
		"do not read or use a skill merely because its broad topic overlaps",
		"you MUST first call read_skill",
		"read its SKILL.md completely",
		"Next offset",
		"Never infer or apply instructions from only a skill's name or description",
		`"id":"python"`,
		`"description":"Use for account reviews."`,
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("skill prompt missing %q: %s", want, prompt)
		}
	}
	if messages[3].Role != "user" {
		t.Fatal("user message should follow skill prompt")
	}
}

func TestBuildKeepsProtectedMessagesBeforeClientMessages(t *testing.T) {
	protected := []model.Message{{Role: "system", Content: "Protected template metadata."}}
	messages, err := BuildWithProtectedMessages(SalesChat, []model.Message{{Role: "user", Content: "Create a QBR."}}, protected, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 4 || messages[2].Content != "Protected template metadata." || messages[3].Role != "user" {
		t.Fatalf("unexpected prompt order: %#v", messages)
	}
}

func TestBuildRejectsUnknownRoute(t *testing.T) {
	_, err := Build(Route("provider/passthrough"), []model.Message{{Role: "user", Content: "hello"}})
	if err == nil {
		t.Fatal("expected unknown route error")
	}
}
