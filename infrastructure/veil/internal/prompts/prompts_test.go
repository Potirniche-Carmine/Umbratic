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
		t.Fatalf("first message should be the global system prompt")
	}
	routePrompt, _ := RoutePrompt(EngineeringChat)
	if messages[1].Role != "system" || messages[1].Content != routePrompt {
		t.Fatalf("second message should be the route system prompt")
	}
	if messages[2].Role != "user" {
		t.Fatalf("client message should follow server prompts")
	}
}

func TestGlobalPromptRequiresUmbraticIdentity(t *testing.T) {
	lower := strings.ToLower(GlobalSystemPrompt)
	for _, want := range []string{"umbratic ai", "underlying model", "vendor", "runtime details"} {
		if !strings.Contains(lower, want) {
			t.Fatalf("global prompt missing %q: %q", want, GlobalSystemPrompt)
		}
	}
}

func TestIdentityPromptsDoNotExposeVeilName(t *testing.T) {
	lower := strings.ToLower(GlobalSystemPrompt)
	if strings.Contains(lower, "veil") {
		t.Fatalf("identity prompts should not expose Veil name: %q", lower)
	}
}

func TestBuildAddsRequestedRuntimePrompts(t *testing.T) {
	messages, err := Build(EngineeringChat, []model.Message{{Role: "user", Content: "fix script.py"}}, RuntimeWorkspaceToolchain, RuntimePython)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 5 {
		t.Fatalf("got %d messages, want 5", len(messages))
	}
	if !strings.Contains(messages[2].Content.(string), "Workspace tool policy") {
		t.Fatalf("missing workspace runtime prompt: %#v", messages[2])
	}
	if !strings.Contains(messages[3].Content.(string), "Python runtime policy") {
		t.Fatalf("missing python runtime prompt: %#v", messages[3])
	}
	if messages[4].Role != "user" {
		t.Fatalf("client message should follow runtime prompts: %#v", messages[4])
	}
}

func TestEngineeringPromptDoesNotAlwaysIncludePythonPolicy(t *testing.T) {
	routePrompt, ok := RoutePrompt(EngineeringChat)
	if !ok {
		t.Fatal("missing engineering prompt")
	}
	if strings.Contains(strings.ToLower(routePrompt), "python") || strings.Contains(strings.ToLower(routePrompt), "uv") {
		t.Fatalf("engineering route prompt should not contain runtime-specific Python policy: %q", routePrompt)
	}
}

func TestWorkspaceToolPromptUsesAvailableToolsWithoutSpecificShellSearchCommands(t *testing.T) {
	prompt, ok := RuntimePrompt(RuntimeWorkspaceToolchain)
	if !ok {
		t.Fatal("missing workspace tool prompt")
	}
	lower := strings.ToLower(prompt)
	for _, want := range []string{
		"bounded preview",
		"not a complete filesystem inventory",
		"existing",
		"subfolders",
		"project structure",
		"read tool",
		"nested directory inventories",
		"search tool",
		"file-changing tools",
	} {
		if !strings.Contains(lower, want) {
			t.Fatalf("workspace tool prompt missing %q: %q", want, prompt)
		}
	}
	for _, blocked := range []string{"rg", "fd", "fdfind", "ripgrep", "tree-sitter", "batcat"} {
		if strings.Contains(lower, blocked) {
			t.Fatalf("workspace tool prompt should not prescribe %q: %q", blocked, prompt)
		}
	}
}

func TestBuildRejectsUnknownRoute(t *testing.T) {
	_, err := Build(Route("provider/passthrough"), []model.Message{{Role: "user", Content: "hello"}})
	if err == nil {
		t.Fatal("expected unknown route error")
	}
}

func TestBuildDedupesRuntimePrompts(t *testing.T) {
	messages, err := Build(EngineeringChat, []model.Message{{Role: "user", Content: "fix git workflow"}}, RuntimeGit, RuntimeGit, RuntimeWorktree)
	if err != nil {
		t.Fatal(err)
	}
	countGit := 0
	countWorktree := 0
	for _, message := range messages {
		content, _ := message.Content.(string)
		if strings.Contains(content, "Git policy") {
			countGit++
		}
		if strings.Contains(content, "Worktree policy") {
			countWorktree++
		}
	}
	if countGit != 1 || countWorktree != 1 {
		t.Fatalf("runtime prompts were not deduped: git=%d worktree=%d messages=%#v", countGit, countWorktree, messages)
	}
}

func TestRouteAndRuntimeCatalogsContainExpectedProfiles(t *testing.T) {
	for _, route := range []Route{EngineeringChat, MarketingChat, SalesChat} {
		if prompt, ok := RoutePrompt(route); !ok || prompt == "" {
			t.Fatalf("missing route prompt for %q", route)
		}
	}
	for _, profile := range []RuntimeProfile{
		RuntimeWorkspaceToolchain,
		RuntimePython,
		RuntimeCCmake,
		RuntimeMarkdown,
		RuntimeGit,
		RuntimeWorktree,
	} {
		if !IsRuntimeProfile(profile) {
			t.Fatalf("profile %q should be supported", profile)
		}
		if prompt, ok := RuntimePrompt(profile); !ok || prompt == "" {
			t.Fatalf("missing runtime prompt for %q", profile)
		}
	}
	if IsRuntimeProfile("custom-system-prompt") {
		t.Fatal("unexpected custom runtime profile support")
	}
}
