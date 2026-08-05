package prompts

import (
	"strings"
	"testing"

	"umbratic-veil/internal/model"
)

func allRoutes() []Route {
	return []Route{EngineeringChat, MarketingChat, SalesChat}
}

// Every route must offer both the no-playbook escape and the conservative
// catch-all, and must declare each id exactly once.
func TestEveryRouteCatalogIsClosedAndComplete(t *testing.T) {
	for _, route := range allRoutes() {
		buckets, ok := RouteBuckets(route)
		if !ok || len(buckets) == 0 {
			t.Fatalf("%s has no bucket catalog", route)
		}
		seen := map[string]bool{}
		for _, bucket := range buckets {
			if seen[bucket.ID] {
				t.Fatalf("%s declares %s twice", route, bucket.ID)
			}
			seen[bucket.ID] = true
			if strings.TrimSpace(bucket.When) == "" {
				t.Fatalf("%s/%s has no classifier description", route, bucket.ID)
			}
			if bucket.ID != DirectAnswerBucket {
				if strings.TrimSpace(bucket.Playbook) == "" {
					t.Fatalf("%s/%s has no playbook", route, bucket.ID)
				}
				if strings.TrimSpace(bucket.Stop) == "" {
					t.Fatalf("%s/%s has no stop rule", route, bucket.ID)
				}
			}
		}
		if !seen[DirectAnswerBucket] {
			t.Fatalf("%s is missing %s", route, DirectAnswerBucket)
		}
		if !seen[OpenTaskBucket] {
			t.Fatalf("%s is missing %s", route, OpenTaskBucket)
		}
	}
}

// direct_answer carries no playbook at all: a degraded or direct run must
// assemble byte-identically to today.
func TestDirectAnswerAndUnknownBucketsRenderNoPlaybook(t *testing.T) {
	skills := []SkillMetadata{{ID: "umbratic-discovery"}}
	for _, route := range allRoutes() {
		for _, id := range []string{DirectAnswerBucket, "", "not_a_bucket", "positioning"} {
			if id == "positioning" && route == MarketingChat {
				continue
			}
			if got := PlaybookPrompt(route, id, skills); got != "" {
				t.Fatalf("%s/%q rendered a playbook: %q", route, id, got)
			}
		}
	}
}

func TestPlaybookRendersBodyStopAndOnlyEnabledSkills(t *testing.T) {
	enabled := []SkillMetadata{{ID: "umbratic-security-review"}, {ID: "umbratic-markdown"}}
	rendered := PlaybookPrompt(EngineeringChat, "deep_review", enabled)
	if rendered == "" {
		t.Fatal("deep_review must render a playbook")
	}
	for _, want := range []string{
		"Active task playbook (harness-internal).",
		"Do not mention playbooks, buckets, or routing to the user.",
		"A one-sentence preamble has already been shown to the user",
		"Preferred skills (optional): umbratic-security-review",
		"read_skill",
		"Stop when: ",
		"Anti-loop: after a tool failure",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("deep_review playbook is missing %q:\n%s", want, rendered)
		}
	}
	// umbratic-git-worktree is preferred but not enabled here, so it must not
	// be named. Every playbook has to work without its preferred skills.
	if strings.Contains(rendered, "umbratic-git-worktree") {
		t.Fatal("a disabled preferred skill must be omitted")
	}

	// With no catalog at all the playbook still carries its core rules.
	bare := PlaybookPrompt(EngineeringChat, "deep_review", nil)
	if bare == "" || strings.Contains(bare, "Preferred skills") {
		t.Fatalf("playbook must stand alone without skills:\n%s", bare)
	}
	if !strings.Contains(bare, "Not covered") {
		t.Fatal("deep_review must keep its coverage-reporting rule without the skill")
	}
}

func TestOrientPromptListsExactlyTheRouteCatalog(t *testing.T) {
	messages, err := BuildOrient(EngineeringChat, "why is the auth test failing?", "code_change")
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Role != "system" || messages[1].Role != "user" {
		t.Fatalf("orient must be one system and one user message, got %+v", messages)
	}
	system := messages[0].Content.(string)
	buckets, _ := RouteBuckets(EngineeringChat)
	for _, bucket := range buckets {
		if !strings.Contains(system, "- "+bucket.ID+": ") {
			t.Fatalf("orient prompt omits %s", bucket.ID)
		}
	}
	// Cross-route ids must not leak into another route's enum.
	if strings.Contains(system, "campaign_plan") || strings.Contains(system, "proposal_draft") {
		t.Fatal("engineering orient prompt leaked a business bucket")
	}
	if !strings.Contains(system, `"think hard"`) {
		t.Fatal("orient prompt must exclude think-hard from security routing")
	}
	user := messages[1].Content.(string)
	if !strings.Contains(user, "Previous bucket for this conversation: code_change") {
		t.Fatal("a valid previous bucket must travel as a continuity hint")
	}
	if !strings.Contains(user, "why is the auth test failing?") {
		t.Fatal("orient must carry the request text")
	}

	// A hint from another route is not a hint here.
	crossRoute, err := BuildOrient(EngineeringChat, "yes, draft it", "campaign_plan")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(crossRoute[1].Content.(string), "campaign_plan") {
		t.Fatal("a cross-route previous bucket must be dropped")
	}

	if _, err := BuildOrient(Route("nope/chat"), "hello", ""); err == nil {
		t.Fatal("an unknown route must not build an orient request")
	}
}

func TestOrientDecisionValidationAppliesExactlyTwoCoercions(t *testing.T) {
	valid := func(raw string) OrientDecision {
		decision, err := ParseOrientDecision(EngineeringChat, raw)
		if err != nil {
			t.Fatalf("expected %s to be valid: %v", raw, err)
		}
		return decision
	}

	got := valid(`{"bucket":"code_change","summarySentence":"I'll find the insertion points and make the change."}`)
	if got.Bucket != "code_change" || got.SummarySentence == "" {
		t.Fatalf("unexpected decision %+v", got)
	}

	// Coercion 1: parseable but unknown bucket falls back to open_task.
	coerced := valid(`{"bucket":"invent_something","summarySentence":"I'll take the smallest useful step."}`)
	if coerced.Bucket != OpenTaskBucket {
		t.Fatalf("unknown bucket must coerce to %s, got %s", OpenTaskBucket, coerced.Bucket)
	}

	// Coercion 2: direct_answer never carries a sentence.
	forced := valid(`{"bucket":"direct_answer","summarySentence":"I'll answer this now."}`)
	if forced.Bucket != DirectAnswerBucket || forced.SummarySentence != "" {
		t.Fatalf("direct_answer must force a null summary, got %+v", forced)
	}
	if plain := valid(`{"bucket":"direct_answer","summarySentence":null}`); plain.SummarySentence != "" {
		t.Fatal("explicit null must decode as no sentence")
	}

	for name, raw := range map[string]string{
		"not json":            `I think this is a code change.`,
		"fenced":              "```json\n{\"bucket\":\"code_change\",\"summarySentence\":\"Doing it.\"}\n```",
		"unknown field":       `{"bucket":"code_change","summarySentence":"Doing it.","confidence":0.9}`,
		"missing bucket":      `{"summarySentence":"Doing it."}`,
		"non-string bucket":   `{"bucket":7,"summarySentence":"Doing it."}`,
		"non-string sentence": `{"bucket":"code_change","summarySentence":42}`,
		"null sentence":       `{"bucket":"code_change","summarySentence":null}`,
		"empty sentence":      `{"bucket":"code_change","summarySentence":"   "}`,
		"no terminator":       `{"bucket":"code_change","summarySentence":"I will make the change"}`,
		"multi line":          `{"bucket":"code_change","summarySentence":"First.\nSecond."}`,
		"names a bucket":      `{"bucket":"deep_review","summarySentence":"Running a deep_review of the auth code."}`,
		"names bucket cased":  `{"bucket":"code_change","summarySentence":"Starting the Code_Change now."}`,
		"too long": `{"bucket":"code_change","summarySentence":"` +
			strings.Repeat("x", MaxSummarySentenceRunes) + `."}`,
	} {
		if _, err := ParseOrientDecision(EngineeringChat, raw); err == nil {
			t.Fatalf("%s must be rejected: %s", name, raw)
		}
	}

	// A sentence that merely contains a bucket id as a substring of a longer
	// word is fine; only standalone tokens are rejected.
	valid(`{"bucket":"code_change","summarySentence":"I'll review the codebase quickly."}`)

	if _, err := ParseOrientDecision(Route("nope/chat"), `{"bucket":"code_change","summarySentence":"Doing it."}`); err == nil {
		t.Fatal("an unknown route must invalidate the decision")
	}
}

// The playbook is the last protected system message, after the skill catalog.
// Everything before it stays byte-stable, so only the playbook slot varies.
func TestPlaybookIsTheLastProtectedSegment(t *testing.T) {
	skills := []SkillMetadata{{ID: "umbratic-python"}}
	client := []model.Message{{Role: "user", Content: "fix the failing test"}}
	playbook := PlaybookPrompt(EngineeringChat, "debug_failure", skills)
	if playbook == "" {
		t.Fatal("debug_failure must render a playbook")
	}
	assembled, err := BuildWithProtectedMessages(
		EngineeringChat, client, []model.Message{{Role: "system", Content: playbook}}, skills)
	if err != nil {
		t.Fatal(err)
	}
	if len(assembled) != 5 {
		t.Fatalf("expected global, route, catalog, playbook, client; got %d", len(assembled))
	}
	if assembled[0].Content.(string) != GlobalSystemPrompt {
		t.Fatal("global prompt must stay first")
	}
	if !strings.Contains(assembled[2].Content.(string), "skill catalog") {
		t.Fatal("skill catalog must precede the playbook")
	}
	if assembled[3].Content.(string) != playbook {
		t.Fatal("playbook must be the last protected message")
	}
	if assembled[4].Role != "user" {
		t.Fatal("client messages must follow the playbook")
	}

	// The guaranteed-stable protected prefix now ends at the skill catalog.
	baseline, err := BuildWithProtectedMessages(EngineeringChat, client, nil, skills)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if baseline[i].Content.(string) != assembled[i].Content.(string) {
			t.Fatalf("protected prefix segment %d changed when a playbook was added", i)
		}
	}
	if len(baseline) != 4 {
		t.Fatalf("a run with no bucket must add no playbook, got %d segments", len(baseline))
	}
}
