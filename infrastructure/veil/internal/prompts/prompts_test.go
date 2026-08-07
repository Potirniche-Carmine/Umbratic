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
	routePrompt := routePrompts[EngineeringChat]
	if messages[1].Role != "system" || messages[1].Content != routePrompt {
		t.Fatal("second message should be the route system prompt")
	}
	if messages[2].Role != "user" {
		t.Fatal("client message should follow server prompts")
	}
}

func TestGlobalAndEngineeringPromptsKeepGeneralScope(t *testing.T) {
	global := strings.ToLower(GlobalSystemPrompt)
	for _, want := range []string{"umbratic", "private and confidential ai assistant", "software and non-software", "latest user message defines the current request", "changes, narrows, or replaces", "do not resume an obsolete plan", "evidence already collected", "workspace preview", "decide from the request's meaning, not from keywords", "do not mention supplied workspace context unless it is relevant", "read-only requests do not authorize file changes", "file-changing tool", "valid json object", "oldtext", "stop using tools", "do not repeat the file's code", "materially different correction", "read_attachment", "read status is complete", "never claim whole-document coverage from an excerpt alone", "never print tool tags", "never invent, rename, alias", "command and run_program tools are different contracts", "emit them together in one response", "should normally begin with a preamble", "exactly one sentence, never two", "belongs in the final response", "do not provide a complete answer and tool calls", "do not encode the preamble as json", "user rejected", "never guess a workspace filename", "one exact file path, not a glob or directory"} {
		if !strings.Contains(global, want) {
			t.Fatalf("global prompt missing %q: %q", want, GlobalSystemPrompt)
		}
	}
	// search is the single text-search tool, covering names, literals, and
	// regex. Locating must beat opening, and an open must be a window: those two
	// rules are what keep whole-file reads out of the transcript.
	for _, want := range []string{
		"search is the only text-search tool",
		"mode path to locate files by name, mode content for exact literal text, and mode regex for a pattern",
		"never use command to run ripgrep, grep, or find for routine search",
		"a content or regex search with context often shows enough of the surrounding code to answer without a read at all",
		"read a window around them rather than the whole file",
		"send line with the reported line number",
	} {
		if !strings.Contains(global, want) {
			t.Fatalf("global prompt missing search-first guidance %q", want)
		}
	}
	// grep was merged into search. The prompt may still forbid shelling out to
	// it, but it must never direct the model to call a grep tool, because the
	// surface no longer declares one.
	for _, line := range strings.Split(global, ". ") {
		if strings.Contains(line, "grep") && !strings.Contains(line, "never use command to run ripgrep") {
			t.Errorf("prompt still points at a grep tool that no longer exists: %q", line)
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
	route := routePrompts[EngineeringChat]
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

// Conduct is stated once, at the global tier. The playbook header is re-sent on
// every step of the turn and is the nearest instruction the model sees before
// each tool call; repeating the preamble rule there made formatting, not the
// plan, the dominant instruction. The global prompt embeds the rule verbatim
// and the playbook header must not restate it in any form.
func TestThePreambleRuleLivesOnlyInTheGlobalPrompt(t *testing.T) {
	if !strings.Contains(GlobalSystemPrompt, PreambleRule) {
		t.Fatal("the global prompt must embed PreambleRule verbatim, not paraphrase it")
	}
	if strings.Contains(playbookHeader, PreambleRule) {
		t.Fatal("the playbook header must not duplicate PreambleRule per step")
	}
	if strings.Contains(strings.ToLower(playbookHeader), "preamble") {
		t.Fatal("the playbook header must not paraphrase preamble conduct; that is global-prompt territory")
	}
	// Old header wordings that contradicted the global rule must stay gone.
	for _, gone := range []string{
		"already been shown to the user",
		"second status preamble",
		"at most three short sentences",
	} {
		if strings.Contains(GlobalSystemPrompt, gone) || strings.Contains(playbookHeader, gone) {
			t.Fatalf("contradicting preamble guidance %q is still present", gone)
		}
	}
}

// The global prompt owns identity, safety, and tool mechanics; the playbook
// owns the workflow. A workflow directive in the global prompt re-litigates a
// decision the classifier already made and competes with the playbook, so any
// phrase that prescribes whether to use tools or a task recipe is banned here.
func TestGlobalPromptCarriesNoWorkflowDirectives(t *testing.T) {
	global := strings.ToLower(GlobalSystemPrompt)
	for _, directive := range []string{
		// Whether-to-use-tools heuristics: that decision belongs to orient.
		"answer directly and do not call a tool",
		"do not inspect the workspace only to fill a direct answer",
		// Task recipes: repo_orient step 1 must not live in the global prompt.
		"for an exhaustive folder overview",
		"begin with ls",
		"use find for recursion",
		// Step-level deliverable anchoring is playbook territory too.
		"in your final response",
	} {
		if strings.Contains(global, directive) {
			t.Fatalf("global prompt contains workflow directive %q", directive)
		}
	}
	// The precedence rule is what replaces those directives: the playbook
	// defines the plan and the global prompt must say it does not compete.
	for _, want := range []string{
		"it defines the turn's plan",
		"they do not override a present playbook's plan",
	} {
		if !strings.Contains(global, want) {
			t.Fatalf("global prompt missing precedence statement %q", want)
		}
	}
}
