package prompts

import (
	"strings"
	"testing"

	"umbratic-veil/internal/model"
)

// allWorkspaceTools returns an OpenAI-style tool array covering every workspace
// tool the global prompt and playbooks may name. Tests that want the full
// prompt text pass this so every gated bullet renders.
func allWorkspaceTools() any {
	names := []string{
		"command",
		"search",
		"ls",
		"find",
		"read",
		"edit",
		"read_attachment",
		"retrieve_context",
		"run_program",
		"workspace_graph",
	}
	tools := make([]any, 0, len(names))
	for _, name := range names {
		tools = append(tools, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name": name,
			},
		})
	}
	return tools
}

// withoutWorkspaceTool is the disabled-tool case. Every workspace tool is
// individually disableable in the desktop, so this is an ordinary
// configuration, not an edge case.
func withoutWorkspaceTool(dropped string) any {
	kept := []any{}
	for _, tool := range allWorkspaceTools().([]any) {
		function := tool.(map[string]any)["function"].(map[string]any)
		if function["name"] == dropped {
			continue
		}
		kept = append(kept, tool)
	}
	return kept
}

// A prompt that names a tool the request never declared is worse than silence:
// the model calls what it was promised, takes an unknown_tool violation, and
// spends its repair attempts on a tool that was never there. Turning search off
// used to leave the model told that "search is the only text-search tool" while
// also being forbidden to reach for grep through command.
func TestGlobalPromptOnlyDescribesDeclaredTools(t *testing.T) {
	full := GlobalSystemPrompt(allWorkspaceTools())

	withoutSearch := GlobalSystemPrompt(withoutWorkspaceTool("search"))
	for _, gone := range []string{
		"search is the only text-search tool",
		"never use command to run ripgrep, grep, or find for routine search",
		"a content or regex search with context",
		"When a search hit already tells you which line matters",
	} {
		if strings.Contains(withoutSearch, gone) {
			t.Fatalf("a request without search still describes it: %q", gone)
		}
	}
	// Conduct is not tool mechanics, so none of it depends on the tool array.
	for _, kept := range []string{
		"private and confidential AI assistant",
		"Follow protected system and route instructions",
		"Your final response is the one with no tool calls",
	} {
		if !strings.Contains(withoutSearch, kept) {
			t.Fatalf("a disabled tool must not cost conduct guidance: %q", kept)
		}
	}

	withoutCommand := GlobalSystemPrompt(withoutWorkspaceTool("command"))
	if strings.Contains(withoutCommand, "The command and run_program tools are different contracts") {
		t.Fatal("a request without command still teaches its argument contract")
	}

	withoutAttachments := GlobalSystemPrompt(withoutWorkspaceTool("read_attachment"))
	if strings.Contains(withoutAttachments, "read_attachment") {
		t.Fatal("a request without read_attachment still names it")
	}

	// A request that carries no tools at all has no tool mechanics to state, so
	// the section built from them disappears with its header.
	bare := GlobalSystemPrompt(nil)
	if strings.Contains(bare, "Finding and reading files:") {
		t.Fatal("an empty tool array must not render a tool section header")
	}
	if !strings.Contains(bare, "private and confidential AI assistant") {
		t.Fatal("identity survives a request with no tools")
	}

	// The full surface is still the full text: gating removes, never rewrites.
	for _, prompt := range []string{withoutSearch, withoutCommand, bare} {
		if len(prompt) >= len(full) {
			t.Fatal("dropping a tool must shorten the prompt")
		}
	}
}

func TestBuildAddsGlobalAndRoutePrompts(t *testing.T) {
	messages, err := Build(EngineeringChat, []model.Message{{Role: "user", Content: "Help me test this."}}, allWorkspaceTools())
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 3 {
		t.Fatalf("got %d messages, want 3", len(messages))
	}
	if messages[0].Role != "system" || messages[0].Content != GlobalSystemPrompt(allWorkspaceTools()) {
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
	globalPrompt := GlobalSystemPrompt(allWorkspaceTools())
	global := strings.ToLower(globalPrompt)
	for _, want := range []string{"umbratic", "private and confidential ai assistant", "software and non-software", "latest user message defines the current request", "changes, narrows, or replaces", "do not resume an obsolete plan", "evidence already collected", "workspace preview", "decide from the request's meaning, not from keywords", "do not mention supplied workspace context unless it is relevant", "read-only requests do not authorize file changes", "file-changing tool", "valid json object", "oldtext", "stop using tools", "do not repeat the file's code", "materially different correction", "read_attachment", "read status is complete", "never claim whole-document coverage from an excerpt alone", "never print tool tags", "never invent, rename, alias", "command and run_program tools are different contracts", "emit them together in one response", "save what you found for the final response", "your final response is the one with no tool calls", "user rejected", "never guess a workspace filename", "one exact file path, not a glob or directory"} {
		if !strings.Contains(global, want) {
			t.Fatalf("global prompt missing %q: %q", want, globalPrompt)
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
	messages, err := BuildWithProtectedMessages(EngineeringChat, []model.Message{{Role: "user", Content: "Fix tests."}}, nil, skills, allWorkspaceTools())
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
		"Review the names and descriptions for relevance",
		"One request may use multiple enabled skills",
		"Use the smallest relevant set",
		"you MUST first call read_skill",
		"Do this for every skill you use",
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
	messages, err := BuildWithProtectedMessages(SalesChat, []model.Message{{Role: "user", Content: "Create a QBR."}}, protected, nil, allWorkspaceTools())
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 4 || messages[2].Content != "Protected template metadata." || messages[3].Role != "user" {
		t.Fatalf("unexpected prompt order: %#v", messages)
	}
}

func TestBuildRejectsUnknownRoute(t *testing.T) {
	_, err := Build(Route("provider/passthrough"), []model.Message{{Role: "user", Content: "hello"}}, nil)
	if err == nil {
		t.Fatal("expected unknown route error")
	}
}

// The per-tool-call status line is retired from the prompts entirely: mid-run
// tool rows narrate the work, so no prompt tier may reintroduce a per-call
// preamble.
func TestNoPromptTierAsksForAPerCallStatusLine(t *testing.T) {
	for _, prompt := range []string{GlobalSystemPrompt(allWorkspaceTools()), playbookHeader} {
		for _, gone := range []string{
			"Status line",
			"one short sentence",
			"Before each tool call",
			"before each tool call",
			"Write one sentence, then stop",
			"already been shown to the user",
			"second status preamble",
			"at most three short sentences",
			"call its tool in the same message you mention it",
			"first tool call",
			"the next tool",
		} {
			if strings.Contains(prompt, gone) {
				t.Fatalf("a prompt tier still asks for a per-call status line (%q)", gone)
			}
		}
	}
	// What survives is the final-message anchor, in both tiers: the answer is
	// the message with no tool calls, and findings belong there.
	if !strings.Contains(strings.ToLower(GlobalSystemPrompt(allWorkspaceTools())), "your final response is the one with no tool calls") {
		t.Fatal("the global prompt lost its final-message anchor")
	}
	if !strings.Contains(playbookHeader, "Speak to the user only in your last message, the one with no tool calls") {
		t.Fatal("the playbook header lost its final-message anchor")
	}
}

// The global prompt owns identity, safety, and tool mechanics. Skills carry
// task-specific workflows. A phrase that prescribes a task recipe or whether
// to use tools belongs in a skill, not here.
func TestGlobalPromptCarriesNoWorkflowDirectives(t *testing.T) {
	global := strings.ToLower(GlobalSystemPrompt(allWorkspaceTools()))
	for _, directive := range []string{
		"answer directly and do not call a tool",
		"do not inspect the workspace only to fill a direct answer",
		"for an exhaustive folder overview",
		"begin with ls",
		"use find for recursion",
		"in your final response",
		"protected task playbook",
		"harness_bucket",
	} {
		if strings.Contains(global, directive) {
			t.Fatalf("global prompt contains workflow directive %q", directive)
		}
	}
}
