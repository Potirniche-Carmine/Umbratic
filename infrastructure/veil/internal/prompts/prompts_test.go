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
	for _, want := range []string{"umbratic", "private and confidential ai assistant", "software and non-software", "latest user message defines the current request", "changes, narrows, or replaces", "do not resume an obsolete plan", "evidence already collected", "workspace preview", "decide from the request's meaning, not from keywords", "do not mention supplied workspace context unless it is relevant", "read-only requests do not authorize file changes", "file-changing tool", "valid json object", "oldtext", "stop using tools", "do not repeat the file's code", "materially different correction", "read_attachment", "read status is complete", "never claim whole-document coverage from an excerpt alone", "never print tool tags", "never invent, rename, alias", "command and run_program tools are different contracts", "emit them together in one response", "one short plain sentence", "at most three short sentences", "save every finding for the final answer", "do not provide a complete answer and tool calls", "do not encode the preamble as json", "user rejected", "never guess a workspace filename", "one exact file path, not a glob or directory"} {
		if !strings.Contains(global, want) {
			t.Fatalf("global prompt missing %q: %q", want, GlobalSystemPrompt)
		}
	}
	// search is the warm primary locator; grep stays the exact escape hatch.
	for _, want := range []string{
		"use search to locate code or content by name or literal text",
		"grep only when you need an exact regex or context lines",
		"never use command to run ripgrep, grep, or find for routine search",
	} {
		if !strings.Contains(global, want) {
			t.Fatalf("global prompt missing search-first guidance %q", want)
		}
	}
	// The promise/tool sentence is deleted in full, including its colon clause.
	// Its anti-stall behavior lives in the bucket playbooks' stop and anti-loop
	// rules, so discovery buckets may end a turn on questions alone.
	for _, gone := range []string{
		"never end a turn by merely saying you will read",
		"make the structured tool call in that turn",
		"provide the complete final answer from results already obtained",
		"prefer ls, find, and grep to shell listing",
	} {
		if strings.Contains(global, gone) {
			t.Fatalf("global prompt still contains removed guidance %q", gone)
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
	if messages[2].Role != "system" {
		t.Fatal("skill catalog should use the system tier")
	}
	for _, want := range []string{
		"optional task-specific playbooks",
		"not an exhaustive capability list",
		"If no skill would materially help, handle the request normally",
		"Do not describe your general capabilities by enumerating enabled skills",
		"Consider relevant skills when they are likely to improve the result",
		"do not read or use a skill merely because its broad topic overlaps",
		"never sweep through multiple skills speculatively",
		"select at most one materially relevant skill",
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

func TestRelevantSkillsHidesPathScopedEntriesUntilToolTouch(t *testing.T) {
	skills := []SkillMetadata{
		{ID: "always", Name: "Always", Source: "system"},
		{ID: "rust", Name: "Rust", Source: "local", Paths: []string{"packages/runner/**"}},
		{ID: "typescript", Name: "TypeScript", Source: "local", Paths: []string{"**/*.ts"}},
	}
	visible := RelevantSkills(skills, []model.Message{{Role: "user", Content: "packages/runner/src/lib.rs"}})
	if len(visible) != 1 || visible[0].ID != "always" {
		t.Fatalf("path-scoped skills were visible before a tool touch: %#v", visible)
	}
	visible = RelevantSkills(skills, []model.Message{{Role: "tool", Content: "read: packages/runner/src/lib.rs (ok)"}})
	if len(visible) != 2 || visible[1].ID != "rust" {
		t.Fatalf("matching skill was not revealed: %#v", visible)
	}
	visible = RelevantSkills(skills, []model.Message{{Role: "tool", Content: "edit: apps/desktop/src/main/main.ts (ok)"}})
	if len(visible) != 2 || visible[1].ID != "typescript" {
		t.Fatalf("suffix glob skill was not revealed: %#v", visible)
	}
}
