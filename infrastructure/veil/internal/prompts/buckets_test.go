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
				// Either form renders a plan; a bucket that sets both has two
				// sources for one fact and one of them is dead.
				if strings.TrimSpace(bucket.Playbook) == "" && len(bucket.Steps) == 0 {
					t.Fatalf("%s/%s has no playbook", route, bucket.ID)
				}
				if strings.TrimSpace(bucket.Playbook) != "" && len(bucket.Steps) > 0 {
					t.Fatalf("%s/%s declares both a flat playbook and steps", route, bucket.ID)
				}
				for index := range bucket.GraphSteps {
					if index < 1 || index > len(bucket.Steps) {
						t.Fatalf("%s/%s overrides step %d, which does not exist", route, bucket.ID, index)
					}
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
		"Your task playbook for this turn.",
		"what work happens, in what order, and when to stop",
		"this plan sets the work",
		"Start now with the needed tool call(s)",
		"Keep the plan to yourself",
		"Skills to check for this work: umbratic-security-review",
		"read_skill",
		"Stop when: ",
		"If a tool fails, read the error and try a different approach.",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("deep_review playbook is missing %q:\n%s", want, rendered)
		}
	}
	// The status line is harness-paced now; a per-call formatting rule here
	// would become the nearest instruction before every tool call and compete
	// with the plan.
	for _, gone := range []string{
		"Before each tool call",
		"one short sentence",
		"write one sentence",
		"first tool call",
		"the next tool",
	} {
		if strings.Contains(rendered, gone) {
			t.Fatalf("the playbook must not ask for a per-call status line (%q)", gone)
		}
	}
	// umbratic-git-worktree is preferred but not enabled here, so it must not
	// be named. Every playbook has to work without its preferred skills.
	if strings.Contains(rendered, "umbratic-git-worktree") {
		t.Fatal("a disabled preferred skill must be omitted")
	}

	// With no catalog at all the playbook still carries its core rules.
	bare := PlaybookPrompt(EngineeringChat, "deep_review", nil, nil)
	if bare == "" || strings.Contains(bare, "Skills to check") {
		t.Fatalf("playbook must stand alone without skills:\n%s", bare)
	}
	if !strings.Contains(bare, "Not covered") {
		t.Fatal("deep_review must keep its coverage-reporting rule without the skill")
	}
}

// Every rule repo_orient earned from a live failure, in one place. Each line
// here cost a bad run: a drive-by write during a read-only tour, a wholly
// invented architecture answered before any tool ran, a tour that skipped the
// project's own documentation and guessed filenames instead, a dozen files
// read then summarized in two lines, and a nine-minute tour that read fifty
// source files while the documents next to them went unopened.
// Substituting a step is how the graph variant is built, so every rule below
// has to survive substitution too — otherwise the tool's presence silently
// buys back a failure this bucket already paid for.
func TestRepoOrientKeepsTheRulesItEarned(t *testing.T) {
	graphTools := []any{
		map[string]any{"type": "function", "function": map[string]any{"name": "workspace_graph"}},
	}
	for _, tools := range []any{nil, graphTools} {
		rendered := PlaybookPrompt(EngineeringChat, "repo_orient", nil, tools)
		for name, want := range map[string]string{
			"read-only":            "leave the files as they are",
			"no drive-by fixes":    "name it in your answer",
			"first move is a tool": "A tool is how you learn what is here",
			"docs before source":   "documents before any source",
			"reads every document": "docs folder or contributing notes",
			"source reads bounded": "has stopped being a tour",
			"no guessed paths":     "Read paths you have seen",
			"answer is unbounded":  "as much room as it needs",
			"self-terminating":     "write the answer from what you have",
			"no folder walk":       "Do not ls every subdirectory",
		} {
			if !strings.Contains(rendered, want) {
				t.Fatalf("repo_orient lost its %s rule (%q):\n%s", name, want, rendered)
			}
		}
	}
	rendered := PlaybookPrompt(EngineeringChat, "repo_orient", nil, nil)
	// The exploration budget applies to exploring, not to the answer: the plan
	// still has to say the tour comes after looking.
	if !strings.Contains(rendered, "You just read the project") {
		t.Fatalf("the answer must still rest on what was read:\n%s", rendered)
	}
	bucket, _ := BucketFor(EngineeringChat, "repo_orient")
	if !strings.Contains(bucket.When, "tell me more about this folder") {
		t.Fatal("repo_orient must claim the folder-tour phrasing for the classifier")
	}
	if strings.Contains(rendered, "search for document files") || strings.Contains(rendered, "every other Markdown") {
		t.Fatal("repo_orient must not send the model on a whole-tree document search")
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
			// Both renderings: a structured bucket's steps never appear in
			// Playbook, so checking that field alone would skip them entirely.
			for _, body := range []string{bucket.body(false), bucket.body(true)} {
				for _, name := range banned {
					if strings.Contains(body, name) {
						t.Fatalf("%s/%s names %q; playbooks must work on any project:\n%s",
							route, bucket.ID, name, body)
					}
				}
				// Generic documentation words stay allowed — that is direction,
				// not a filename — but the plan should not run past a screen.
				if lines := strings.Count(body, "\n"); lines > 16 {
					t.Fatalf("%s/%s playbook is %d lines; keep it a plan, not a manual",
						route, bucket.ID, lines)
				}
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
		"whenever reading a file could change the answer",
		"not just one sentence",
		"Read the CURRENT USER REQUEST",
		"Judge this request on its own",
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
	// Marketing and sales still complete from supplied context. Web tools are
	// extra collection when present, not a requirement to open the turn.
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

// The opening status line is the assistant speaking, so it is model-written or
// it is absent — no prompt tier and no catalog may carry a canned sentence for
// it. Reliability comes from the response grammar: summarySentence is a
// required string, so a model that used to answer null now has to write one.
func TestTheOrientationSentenceIsModelWrittenNeverCanned(t *testing.T) {
	schema := OrientResponseSchema()
	properties := schema["properties"].(map[string]any)
	sentence := properties["summarySentence"].(map[string]any)
	if sentence["type"] != "string" {
		t.Fatalf("summarySentence must be grammar-required as a string, got %v", sentence["type"])
	}
	required := schema["required"].([]string)
	if len(required) != 2 || required[0] != "bucket" || required[1] != "summarySentence" {
		t.Fatalf("both fields must be required: %v", required)
	}

	// The classifier prompt asks for the sentence on every decision and never
	// offers null as a way out.
	messages, err := BuildOrient(EngineeringChat, "tell me more about this folder", "")
	if err != nil {
		t.Fatal(err)
	}
	system := messages[0].Content.(string)
	if !strings.Contains(system, "Write summarySentence on every decision") {
		t.Fatalf("the prompt must require the sentence on every decision:\n%s", system)
	}
	for _, gone := range []string{"set summarySentence to null", "<string or null>"} {
		if strings.Contains(system, gone) {
			t.Fatalf("the prompt still offers the null escape (%q)", gone)
		}
	}
}

// "sentence: missing" in the runner log covered both "the classifier returned
// none" and "the one it returned was rejected", which made a live run's absent
// status line unexplainable. The two are now distinguishable.
func TestADroppedSentenceIsDistinguishableFromAnAbsentOne(t *testing.T) {
	// Rejected: the sentence names a bucket id, which is hidden harness state.
	dropped, err := ParseOrientDecision(EngineeringChat, `{"bucket":"repo_orient","summarySentence":"I will start repo_orient on this repository."}`)
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

// The sentence is the only prose every run shows the user, so what disqualifies
// it must be a bound or hidden state — never a spelling of English. Terminal
// "." or "!" used to be required, which discarded whole lines for punctuation
// no other language shares, and a discarded line is indistinguishable from a
// classifier that wrote none.
func TestAStatusSentenceIsNotJudgedOnEnglishPunctuation(t *testing.T) {
	for _, sentence := range []string{
		"I will check whether the retry wrapper is already there?",
		"I will trace the failure through main_test.go and report the cause.",
		"このリポジトリの構成を調べます。",
		"Je vais parcourir la documentation du projet…",
		"I will start with the entry points",
	} {
		raw := `{"bucket":"repo_orient","summarySentence":` + strconv.Quote(sentence) + `}`
		decision, err := ParseOrientDecision(EngineeringChat, raw)
		if err != nil {
			t.Fatalf("%q: %v", sentence, err)
		}
		if decision.SummarySentence != sentence || decision.SentenceDropped {
			t.Fatalf("sentence must survive as written: %q -> %+v", sentence, decision)
		}
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

	// Second person is asked for in the prompt and no longer enforced here.
	// Enforcing it dropped the whole line, so an ordinary phrasing like "your
	// workspace" showed the user nothing where the orientation belongs — which
	// is what live logs were reporting. Awkward wording beats silence.
	for _, kept := range []string{
		"I will map this repository so you can navigate the codebase.",
		"I will read the docs and summarize them for your review.",
	} {
		got := decide(kept)
		if got.SummarySentence != kept || got.SentenceDropped {
			t.Fatalf("a second-person sentence should still reach the user: %q -> %+v", kept, got)
		}
		if got.Bucket != "repo_orient" {
			t.Fatalf("the bucket must survive either way: %+v", got)
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
		"Keep that sentence about your action alone",
		"its language, files, and design are still unknown to you",
		`the words "you" and "your" stay out of it`,
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
		"Read paths you have seen",
		"its error lists what that directory really holds",
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
		`starts with "I will" and says what you are about to do`,
		"keep it under 240 characters",
		`Example: "I will map this project's layout`,
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
		"multi line":          `{"bucket":"code_change","summarySentence":"First.\nSecond."}`,
		"names bucket cased":  `{"bucket":"code_change","summarySentence":"Starting the Code_Change now."}`,
		"too long": `{"bucket":"code_change","summarySentence":"` +
			strings.Repeat("x", MaxSummarySentenceRunes+1) + `"}`,
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
		EngineeringChat, client, []model.Message{{Role: "system", Content: playbook}}, skills, allWorkspaceTools())
	if err != nil {
		t.Fatal(err)
	}
	if len(assembled) != 5 {
		t.Fatalf("expected global, route, catalog, playbook, client; got %d", len(assembled))
	}
	if assembled[0].Content.(string) != GlobalSystemPrompt(allWorkspaceTools()) {
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
	baseline, err := BuildWithProtectedMessages(EngineeringChat, client, nil, skills, allWorkspaceTools())
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

// Public-web guidance is the same contract as graph guidance: name the tools
// only when the request actually declared them, so a run with web search off
// assembles the playbook it had before those tools existed.
func TestWebGuidanceRendersOnlyWhenBothToolsArePresent(t *testing.T) {
	both := []any{
		map[string]any{"type": "function", "function": map[string]any{"name": "web_search"}},
		map[string]any{"type": "function", "function": map[string]any{"name": "web_fetch"}},
	}
	searchOnly := []any{
		map[string]any{"type": "function", "function": map[string]any{"name": "web_search"}},
	}

	for _, trial := range []struct {
		route  Route
		bucket string
	}{
		{MarketingChat, "research_synth"},
		{MarketingChat, "positioning"},
		{SalesChat, "account_research"},
		{SalesChat, "research_synth"},
	} {
		absent := PlaybookPrompt(trial.route, trial.bucket, nil, nil)
		present := PlaybookPrompt(trial.route, trial.bucket, nil, both)
		if strings.Contains(absent, "web_search") || strings.Contains(absent, "web_fetch") {
			t.Fatalf("%s/%s named web tools without them:\n%s", trial.route, trial.bucket, absent)
		}
		if !strings.Contains(present, "web_search") || !strings.Contains(present, "web_fetch") {
			t.Fatalf("%s/%s dropped web guidance with the tools present:\n%s", trial.route, trial.bucket, present)
		}
		if !strings.Contains(present, "Never invent a company domain") {
			t.Fatalf("%s/%s lost the no-invented-domain rule:\n%s", trial.route, trial.bucket, present)
		}
		if PlaybookPrompt(trial.route, trial.bucket, nil, searchOnly) != absent {
			t.Fatalf("%s/%s must require both web tools, not search alone", trial.route, trial.bucket)
		}
	}
}

// Review buckets carry the negative instruction on purpose: telling a small
// model what not to re-read is what actually shortens the tool chain.
func TestReviewBucketsTellTheModelWhatNotToReRead(t *testing.T) {
	tools := []any{map[string]any{"type": "function", "function": map[string]any{"name": "workspace_graph"}}}
	for _, bucket := range []string{"review_audit", "deep_review"} {
		rendered := PlaybookPrompt(EngineeringChat, bucket, nil, tools)
		if !strings.Contains(rendered, "stop there") {
			t.Fatalf("%s lost its bound on how much to read:\n%s", bucket, rendered)
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

// The graph variant must read as one plan, not as a plan plus an amendment.
// The first version of this shipped as "replace step 1" appended after the
// list, and the model followed the original step 1 it had already read.
func TestRepoOrientGraphVariantIsOneCoherentNumberedPlan(t *testing.T) {
	tools := []any{
		map[string]any{"type": "function", "function": map[string]any{"name": "workspace_graph"}},
	}
	rendered := PlaybookPrompt(EngineeringChat, "repo_orient", nil, tools)

	if !strings.Contains(rendered, "1. In one response, call workspace_graph with action summary and read the project's own documents") {
		t.Fatalf("step 1 must itself be the graph call, batched with document reads:\n%s", rendered)
	}
	if strings.Contains(rendered, "1. In one response, list the workspace root") {
		t.Fatalf("the listing imperative must be replaced, not accompanied:\n%s", rendered)
	}
	for _, patch := range []string{"replace step", "instead of step", "skip step"} {
		if strings.Contains(strings.ToLower(rendered), patch) {
			t.Fatalf("the plan must not ask the model to amend it (%q):\n%s", patch, rendered)
		}
	}
	// Later steps gate what counts as a real path. If they still name only a
	// listing, they contradict a step 1 that never lists anything.
	if !strings.Contains(rendered, "Read paths you have seen in the graph") {
		t.Fatalf("a later step must accept the graph as a source of real paths:\n%s", rendered)
	}
	if strings.Contains(rendered, "directories the listing showed") {
		t.Fatalf("step 3 must not depend on a listing that step 1 no longer does:\n%s", rendered)
	}
	// Numbering is generated, so it cannot drift out of order.
	for number := 1; number <= 4; number++ {
		if !strings.Contains(rendered, "\n"+strconv.Itoa(number)+". ") {
			t.Fatalf("step %d is missing from the rendered plan:\n%s", number, rendered)
		}
	}
	if strings.Contains(rendered, "\n5. ") {
		t.Fatalf("substitution must not add a step:\n%s", rendered)
	}
}

// Without the tool the rendered plan must be exactly what shipped before the
// structured form existed: same words, same numbers, no trace of the variant.
func TestRepoOrientWithoutTheGraphRendersTheOriginalPlan(t *testing.T) {
	rendered := PlaybookPrompt(EngineeringChat, "repo_orient", nil, nil)
	if strings.Contains(rendered, "workspace_graph") {
		t.Fatalf("a harness without the tool must never be told to call it:\n%s", rendered)
	}
	if !strings.Contains(rendered, "1. In one response, list the workspace root") {
		t.Fatalf("the original step 1 must survive:\n%s", rendered)
	}
	if !strings.Contains(rendered, "2. Do not ls every subdirectory. The root listing is the layout.") {
		t.Fatalf("the original step 2 must survive:\n%s", rendered)
	}
}
