package prompts

import (
	"strconv"
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
			if got := PlaybookPrompt(route, id, skills, nil); got != "" {
				t.Fatalf("%s/%q rendered a playbook: %q", route, id, got)
			}
		}
	}
}

func TestPlaybookRendersBodyStopAndOnlyEnabledSkills(t *testing.T) {
	enabled := []SkillMetadata{{ID: "umbratic-security-review"}, {ID: "umbratic-markdown"}}
	rendered := PlaybookPrompt(EngineeringChat, "deep_review", enabled, nil)
	if rendered == "" {
		t.Fatal("deep_review must render a playbook")
	}
	for _, want := range []string{
		"Active task playbook (harness-internal).",
		"defines the plan for this turn",
		"they do not override this plan",
		"Begin the plan now",
		"Do not mention playbooks, buckets, or routing to the user.",
		"Preferred skills (optional): umbratic-security-review",
		"read_skill",
		"Stop when: ",
		"Anti-loop: after a tool failure",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("deep_review playbook is missing %q:\n%s", want, rendered)
		}
	}
	// Conduct is stated once, in the global prompt. Repeating the preamble rule
	// per step made formatting the nearest instruction before every tool call.
	if strings.Contains(rendered, PreambleRule) {
		t.Fatal("the playbook must not repeat PreambleRule")
	}
	// umbratic-git-worktree is preferred but not enabled here, so it must not
	// be named. Every playbook has to work without its preferred skills.
	if strings.Contains(rendered, "umbratic-git-worktree") {
		t.Fatal("a disabled preferred skill must be omitted")
	}

	// With no catalog at all the playbook still carries its core rules.
	bare := PlaybookPrompt(EngineeringChat, "deep_review", nil, nil)
	if bare == "" || strings.Contains(bare, "Preferred skills") {
		t.Fatalf("playbook must stand alone without skills:\n%s", bare)
	}
	if !strings.Contains(bare, "Not covered") {
		t.Fatal("deep_review must keep its coverage-reporting rule without the skill")
	}
}

// Every rule repo_orient earned from a live failure, in one place. Each line
// here cost a bad run: a drive-by write during a read-only tour, a wholly
// invented architecture answered before any tool ran, a tour that skipped the
// project's own documentation and guessed filenames instead, and a dozen files
// read then summarized in two lines.
func TestRepoOrientKeepsTheRulesItEarned(t *testing.T) {
	rendered := PlaybookPrompt(EngineeringChat, "repo_orient", nil, nil)
	for name, want := range map[string]string{
		"read-only":            "Never create, edit, or write a file",
		"no drive-by fixes":    "never fix a problem you notice",
		"first move is a tool": "Your first action is a tool call, never prose",
		"docs before source":   "Read the documentation before the source",
		"no guessed paths":     "Read only paths you have actually seen",
		"answer is unbounded":  "Length is yours to judge",
		"self-terminating":     "stop exploring and write the answer from what you have",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("repo_orient lost its %s rule (%q):\n%s", name, want, rendered)
		}
	}
	// The exploration budget may never be read as a budget on the answer.
	if !strings.Contains(rendered, "never a licence to answer before you have looked") {
		t.Fatalf("the anti-stuck rule must not license an early exit:\n%s", rendered)
	}
	bucket, _ := BucketFor(EngineeringChat, "repo_orient")
	if !strings.Contains(bucket.When, "tell me more about this folder") {
		t.Fatal("repo_orient must claim the folder-tour phrasing for the classifier")
	}
}

// A playbook is a plan, not a map of one project. Naming an ecosystem's files
// sends the model looking for them in projects that have none — a live tour
// read package.json on a static site because the playbook listed it — and
// hardcoding tool-call JSON pins the plan to today's tool schema. Direction
// belongs here; specifics belong in whatever the listing actually returns.
func TestPlaybooksStayProjectAgnostic(t *testing.T) {
	banned := []string{
		"package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt",
		"CMakeLists", "Makefile", "AGENTS.md", "CONTRIBUTING", "CHANGELOG",
		".claude", "node_modules", "src/", "tsconfig",
		// Raw tool-call JSON: the schema is the tools' business, not a plan's.
		`{"path"`, `"glob":`,
	}
	for _, route := range allRoutes() {
		buckets, _ := RouteBuckets(route)
		for _, bucket := range buckets {
			for _, name := range banned {
				if strings.Contains(bucket.Playbook, name) {
					t.Fatalf("%s/%s names %q; playbooks must work on any project:\n%s",
						route, bucket.ID, name, bucket.Playbook)
				}
			}
			// Generic documentation words stay allowed — that is direction, not
			// a filename — but the plan should not run past a screen.
			if lines := strings.Count(bucket.Playbook, "\n"); lines > 16 {
				t.Fatalf("%s/%s playbook is %d lines; keep it a plan, not a manual",
					route, bucket.ID, lines)
			}
		}
	}
}

// A live second turn — "can you tell me more about it? Like not just one
// sentence" — classified as direct_answer, so the run lost its playbook and its
// status line while still needing the workspace. It then called four tools
// anyway. The fix is not continuity, which would make a light follow-up inherit
// a heavy plan; it is that direct_answer means "no file could change this".
func TestAWorkspaceFollowUpIsNotADirectAnswer(t *testing.T) {
	messages, err := BuildOrient(EngineeringChat, "can you tell me more about it ? Like not just one sentence", "")
	if err != nil {
		t.Fatal(err)
	}
	system := messages[0].Content.(string)
	for _, want := range []string{
		"ask whether reading a file could change the answer",
		"not just one sentence",
		"Classify only the CURRENT USER REQUEST",
		"Carry no plan forward",
	} {
		if !strings.Contains(system, want) {
			t.Fatalf("orient prompt is missing %q", want)
		}
	}
	// Inheriting a bucket is explicitly not the mechanism.
	if strings.Contains(system, "reuse the previous bucket") {
		t.Fatalf("orient must not carry a bucket between turns:\n%s", system)
	}
	// direct_answer's own description has to turn the follow-up away on the
	// request's own words, with no knowledge of what came before it.
	direct, _ := BucketFor(EngineeringChat, DirectAnswerBucket)
	if !strings.Contains(direct.When, "not just one sentence") {
		t.Fatalf("direct_answer must exclude workspace follow-ups: %q", direct.When)
	}
}

// "yes, go ahead" means nothing on its own, so the classifier is given the tail
// of its own last reply. It is context, never the thing being classified, and
// the two are labelled apart so a model cannot classify the wrong one. What is
// deliberately absent is any bucket: the offer is re-judged on merit rather
// than inherited.
func TestOrientSeparatesItsContextFromTheRequest(t *testing.T) {
	offer := "I can add the retry wrapper to the http client and update its tests. Want me to make that change?"
	messages, err := BuildOrient(EngineeringChat, "yes, go ahead", offer)
	if err != nil {
		t.Fatal(err)
	}
	user := messages[1].Content.(string)
	contextAt := strings.Index(user, "CONTEXT — the end of your own previous reply")
	requestAt := strings.Index(user, "CURRENT USER REQUEST — this is what you classify")
	if contextAt < 0 || requestAt < 0 || contextAt > requestAt {
		t.Fatalf("context must be labelled and precede the request:\n%s", user)
	}
	if !strings.Contains(user, offer) || !strings.Contains(user, "yes, go ahead") {
		t.Fatalf("both halves must survive:\n%s", user)
	}
	if strings.Contains(user, "Previous bucket") {
		t.Fatalf("no bucket may travel with the context:\n%s", user)
	}

	// A first turn carries no context block at all.
	first, err := BuildOrient(EngineeringChat, "tell me about this project", "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(first[1].Content.(string), "CONTEXT") {
		t.Fatalf("an opening turn must carry no context block:\n%s", first[1].Content)
	}

	// A long answer is truncated to its tail, which is where the offer lives.
	long := strings.Repeat("earlier detail. ", 400) + "Want me to make that change?"
	bounded, err := BuildOrient(EngineeringChat, "yes", long)
	if err != nil {
		t.Fatal(err)
	}
	rendered := bounded[1].Content.(string)
	if !strings.Contains(rendered, "Want me to make that change?") {
		t.Fatal("truncation must keep the end of the reply, not the start")
	}
	if len([]rune(rendered)) > MaxOrientContextRunes+len([]rune("yes"))+400 {
		t.Fatalf("context was not bounded: %d runes", len([]rune(rendered)))
	}
}

// The runner enforces "no answer without tool results", but the catalog decides
// which buckets that applies to. A bucket that legitimately ends on questions or
// on supplied context alone must never be marked, or the runner will refuse a
// correct answer.
func TestOnlyEvidenceBackedBucketsRequireEvidence(t *testing.T) {
	required := map[string]bool{
		"repo_orient": true, "code_explain": true, "debug_failure": true,
		"code_change": true, "review_audit": true, "deep_review": true,
		"test_verify": true, "refactor_migrate": true, "docs_change": true,
	}
	buckets, _ := RouteBuckets(EngineeringChat)
	for _, bucket := range buckets {
		if got := bucket.RequiresEvidence; got != required[bucket.ID] {
			t.Fatalf("engineering bucket %q RequiresEvidence = %v, want %v", bucket.ID, got, required[bucket.ID])
		}
		if !RequiresEvidence(EngineeringChat, bucket.ID) == bucket.RequiresEvidence {
			t.Fatalf("RequiresEvidence disagrees with the catalog for %q", bucket.ID)
		}
	}
	// Asking instead of acting is the correct outcome for these, so neither may
	// be held to the evidence rule.
	for _, id := range []string{DirectAnswerBucket, "spec_discovery", OpenTaskBucket} {
		if RequiresEvidence(EngineeringChat, id) {
			t.Fatalf("%q must not require evidence", id)
		}
	}
	// Marketing and sales deliverables come from supplied context, not tools.
	for _, route := range []Route{MarketingChat, SalesChat} {
		buckets, _ := RouteBuckets(route)
		for _, bucket := range buckets {
			if bucket.RequiresEvidence {
				t.Fatalf("%s bucket %q must not require evidence", route, bucket.ID)
			}
		}
	}
	// An unknown selector can never turn the rule on.
	if RequiresEvidence(EngineeringChat, "not_a_bucket") {
		t.Fatal("an unknown bucket must not require evidence")
	}
}

// "sentence: missing" in the runner log covered both "the classifier returned
// none" and "the one it returned was rejected", which made a live run's absent
// status line unexplainable. The two are now distinguishable.
func TestADroppedSentenceIsDistinguishableFromAnAbsentOne(t *testing.T) {
	// Rejected: no terminal punctuation.
	dropped, err := ParseOrientDecision(EngineeringChat, `{"bucket":"repo_orient","summarySentence":"I will map this repository"}`)
	if err != nil {
		t.Fatal(err)
	}
	if dropped.SummarySentence != "" || !dropped.SentenceDropped {
		t.Fatalf("a rejected sentence must be reported as dropped: %+v", dropped)
	}

	// Absent: the classifier returned null.
	absent, err := ParseOrientDecision(EngineeringChat, `{"bucket":"repo_orient","summarySentence":null}`)
	if err != nil {
		t.Fatal(err)
	}
	if absent.SentenceDropped {
		t.Fatalf("an absent sentence is not a dropped one: %+v", absent)
	}

	// A valid sentence is neither.
	kept, err := ParseOrientDecision(EngineeringChat, `{"bucket":"repo_orient","summarySentence":"I will map this repository."}`)
	if err != nil {
		t.Fatal(err)
	}
	if kept.SummarySentence == "" || kept.SentenceDropped {
		t.Fatalf("a valid sentence must survive undropped: %+v", kept)
	}

	// direct_answer carries no sentence and reports no drop.
	direct, err := ParseOrientDecision(EngineeringChat, `{"bucket":"direct_answer","summarySentence":null}`)
	if err != nil {
		t.Fatal(err)
	}
	if direct.SentenceDropped {
		t.Fatalf("direct_answer must never report a dropped sentence: %+v", direct)
	}
}

// A live status line read "I will map out Umbratic's hybrid architecture —
// Electron frontend, Rust backend, and Go security layer — so you can navigate
// the codebase." Two faults in one sentence: it stated an architecture the
// classifier cannot have seen, and it turned to address the reader. The line is
// the assistant narrating its own next action, so second person is rejected.
func TestAStatusSentenceNarratesItsOwnWorkInFirstPerson(t *testing.T) {
	decide := func(sentence string) OrientDecision {
		raw := `{"bucket":"repo_orient","summarySentence":` + strconv.Quote(sentence) + `}`
		decision, err := ParseOrientDecision(EngineeringChat, raw)
		if err != nil {
			t.Fatalf("%q: %v", sentence, err)
		}
		return decision
	}

	for _, rejected := range []string{
		"I will map this repository so you can navigate the codebase.",
		"I will read the docs and summarize them for your review.",
		"Here is what you asked for.",
	} {
		got := decide(rejected)
		if got.SummarySentence != "" || !got.SentenceDropped {
			t.Fatalf("a second-person sentence must be dropped: %q -> %+v", rejected, got)
		}
		if got.Bucket != "repo_orient" {
			t.Fatalf("dropping the sentence must not drop the bucket: %+v", got)
		}
	}

	for _, kept := range []string{
		"I will map this project's layout and read its documentation.",
		"I will start with the repository's own docs, then confirm them against the code.",
		// "young" contains "you" but is not a pronoun; only whole tokens count.
		"I will review the youngest commits first.",
	} {
		got := decide(kept)
		if got.SummarySentence != kept || got.SentenceDropped {
			t.Fatalf("a first-person plan sentence must survive: %q -> %+v", kept, got)
		}
	}

	// The rule the classifier is given has to say both halves out loud.
	messages, err := BuildOrient(EngineeringChat, "tell me about this codebase", "")
	if err != nil {
		t.Fatal(err)
	}
	system := messages[0].Content.(string)
	for _, want := range []string{
		"the sentence may state no fact about it",
		"Never name a language, framework, service, component, architecture, directory, or file",
		`no "so you can ..."`,
	} {
		if !strings.Contains(system, want) {
			t.Fatalf("orient prompt is missing %q", want)
		}
	}
}

// code_explain produced the guessed-sibling read loop: four invented filenames in
// one directory, each answered with that directory's real listing. The rule that
// stops it belongs in the bucket that does the reading.
func TestCodeExplainForbidsGuessedPaths(t *testing.T) {
	rendered := PlaybookPrompt(EngineeringChat, "code_explain", nil, nil)
	for _, want := range []string{
		"Read only paths you have actually seen",
		"never answer a miss by inventing another name beside it",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("code_explain playbook is missing %q:\n%s", want, rendered)
		}
	}
}

// The status sentence is the user's opening progress line, so the classifier is
// told to restate the request as a first-person plan rather than emit a label.
func TestOrientPromptAsksForAFirstPersonPlanSentence(t *testing.T) {
	messages, err := BuildOrient(EngineeringChat, "tell me more about this folder", "")
	if err != nil {
		t.Fatal(err)
	}
	system := messages[0].Content.(string)
	for _, want := range []string{
		"restate the request as your plan",
		"one or two short, natural, plain sentences in the first person",
		`For example: "I will map this folder's layout`,
	} {
		if !strings.Contains(system, want) {
			t.Fatalf("orient prompt missing %q", want)
		}
	}
}

func TestOrientPromptListsExactlyTheRouteCatalog(t *testing.T) {
	messages, err := BuildOrient(EngineeringChat, "why is the auth test failing?", "")
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
	// The user message is the request and nothing else: no carried-over bucket,
	// so a light follow-up can never inherit the previous turn's heavy plan.
	user := messages[1].Content.(string)
	if !strings.Contains(user, "why is the auth test failing?") {
		t.Fatal("orient must carry the request text")
	}
	if strings.Contains(user, "Previous bucket") {
		t.Fatalf("orient must classify each request on its own words:\n%s", user)
	}

	if _, err := BuildOrient(Route("nope/chat"), "hello", ""); err == nil {
		t.Fatal("an unknown route must not build an orient request")
	}
}

func TestOrientDecisionValidationSeparatesTheBucketFromTheSentence(t *testing.T) {
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

	// A parseable but unknown bucket falls back to open_task.
	coerced := valid(`{"bucket":"invent_something","summarySentence":"I'll take the smallest useful step."}`)
	if coerced.Bucket != OpenTaskBucket {
		t.Fatalf("unknown bucket must coerce to %s, got %s", OpenTaskBucket, coerced.Bucket)
	}

	// direct_answer never carries a sentence.
	forced := valid(`{"bucket":"direct_answer","summarySentence":"I'll answer this now."}`)
	if forced.Bucket != DirectAnswerBucket || forced.SummarySentence != "" {
		t.Fatalf("direct_answer must force a null summary, got %+v", forced)
	}
	if plain := valid(`{"bucket":"direct_answer","summarySentence":null}`); plain.SummarySentence != "" {
		t.Fatal("explicit null must decode as no sentence")
	}

	// The sentence is the optional part of the decision: a bad sentence loses
	// the sentence only, and the bucket still guides the run.
	for name, raw := range map[string]string{
		"non-string sentence": `{"bucket":"code_change","summarySentence":42}`,
		"null sentence":       `{"bucket":"code_change","summarySentence":null}`,
		"empty sentence":      `{"bucket":"code_change","summarySentence":"   "}`,
		"no terminator":       `{"bucket":"code_change","summarySentence":"I will make the change"}`,
		"multi line":          `{"bucket":"code_change","summarySentence":"First.\nSecond."}`,
		"names bucket cased":  `{"bucket":"code_change","summarySentence":"Starting the Code_Change now."}`,
		"too long": `{"bucket":"code_change","summarySentence":"` +
			strings.Repeat("x", MaxSummarySentenceRunes) + `."}`,
	} {
		decision := valid(raw)
		if decision.Bucket != "code_change" || decision.SummarySentence != "" {
			t.Fatalf("%s must keep the bucket and drop the sentence, got %+v", name, decision)
		}
	}
	if decision := valid(`{"bucket":"deep_review","summarySentence":"Running a deep_review of the auth code."}`); decision.Bucket != "deep_review" || decision.SummarySentence != "" {
		t.Fatalf("a sentence naming a bucket id must be dropped without losing the bucket, got %+v", decision)
	}

	// A local model wrapping a valid decision in a think block or a code fence
	// is normalized rather than degraded; the wrapped content is still parsed
	// strictly as one JSON object.
	for name, raw := range map[string]string{
		"fenced":        "```json\n{\"bucket\":\"code_change\",\"summarySentence\":\"Doing it.\"}\n```",
		"bare fence":    "```\n{\"bucket\":\"code_change\",\"summarySentence\":\"Doing it.\"}\n```",
		"think block":   "<think>The user wants a change made.</think>\n{\"bucket\":\"code_change\",\"summarySentence\":\"Doing it.\"}",
		"think + fence": "<think>hmm</think>\n```json\n{\"bucket\":\"code_change\",\"summarySentence\":\"Doing it.\"}\n```",
	} {
		if decision := valid(raw); decision.Bucket != "code_change" || decision.SummarySentence != "Doing it." {
			t.Fatalf("%s must normalize to a full decision, got %+v", name, decision)
		}
	}

	// Only a broken envelope invalidates the decision itself.
	for name, raw := range map[string]string{
		"not json":          `I think this is a code change.`,
		"unclosed fence":    "```json\n{\"bucket\":\"code_change\",\"summarySentence\":\"Doing it.\"}",
		"truncated object":  `{"bucket":"code_change","summarySentence":"I will make the ch`,
		"prose then json":   `The decision: {"bucket":"code_change","summarySentence":"Doing it."}`,
		"unknown field":     `{"bucket":"code_change","summarySentence":"Doing it.","confidence":0.9}`,
		"missing bucket":    `{"summarySentence":"Doing it."}`,
		"non-string bucket": `{"bucket":7,"summarySentence":"Doing it."}`,
	} {
		err := func() error {
			_, err := ParseOrientDecision(EngineeringChat, raw)
			return err
		}()
		if err == nil {
			t.Fatalf("%s must be rejected: %s", name, raw)
		}
		if OrientFailureReason(err) == "" {
			t.Fatalf("%s must carry a static failure reason", name)
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
	playbook := PlaybookPrompt(EngineeringChat, "debug_failure", skills, nil)
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

// The graph guidance is conditional on the tool actually being in the request,
// so a harness without the workspace graph assembles the same bytes it does
// today and never reads an instruction to call a tool it does not have.
func TestGraphGuidanceRendersOnlyWhenTheToolIsPresent(t *testing.T) {
	tools := []any{
		map[string]any{"type": "function", "function": map[string]any{"name": "read"}},
		map[string]any{"type": "function", "function": map[string]any{"name": "workspace_graph"}},
	}
	without := []any{map[string]any{"type": "function", "function": map[string]any{"name": "read"}}}

	for _, bucket := range []string{"repo_orient", "code_explain", "code_change", "review_audit"} {
		absent := PlaybookPrompt(EngineeringChat, bucket, nil, without)
		present := PlaybookPrompt(EngineeringChat, bucket, nil, tools)
		if strings.Contains(absent, "workspace_graph") {
			t.Fatalf("%s named workspace_graph without the tool:\n%s", bucket, absent)
		}
		if !strings.Contains(present, "workspace_graph") {
			t.Fatalf("%s dropped its graph guidance with the tool present:\n%s", bucket, present)
		}
		if PlaybookPrompt(EngineeringChat, bucket, nil, nil) != absent {
			t.Fatalf("%s: a nil tool array must render like an array without the tool", bucket)
		}
	}
}

// Review buckets carry the negative instruction on purpose: telling a small
// model what not to re-read is what actually shortens the tool chain.
func TestReviewBucketsTellTheModelWhatNotToReRead(t *testing.T) {
	tools := []any{map[string]any{"type": "function", "function": map[string]any{"name": "workspace_graph"}}}
	for _, bucket := range []string{"review_audit", "deep_review"} {
		rendered := PlaybookPrompt(EngineeringChat, bucket, nil, tools)
		if !strings.Contains(rendered, "Do not re-read files the diff did not touch") {
			t.Fatalf("%s lost its negative read instruction:\n%s", bucket, rendered)
		}
	}
}

func TestHasToolIgnoresMalformedToolArrays(t *testing.T) {
	if HasTool(nil, "workspace_graph") || HasTool("tools", "workspace_graph") {
		t.Fatal("a missing or non-array tool contract must not report a tool")
	}
	if HasTool([]any{map[string]any{"function": "not-an-object"}, 7}, "workspace_graph") {
		t.Fatal("malformed rows must not report a tool")
	}
}
