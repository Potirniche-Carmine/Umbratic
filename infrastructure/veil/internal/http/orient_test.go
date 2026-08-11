package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"umbratic-veil/internal/model"
)

func TestOrientRouteReturnsAValidatedDecisionWithADeterministicProfile(t *testing.T) {
	cfg := testConfig()
	cfg.ContextLength = 64_000
	client := &fakeModelClient{chatContent: `{"bucket":"debug_failure","summarySentence":"I'll inspect the failure path and isolate the cause."}`}
	server := NewServer(cfg, client)
	body := `{"route":"engineering/chat","requestText":"the auth test is failing","previousResponse":"I can make that change."}`
	req := httptest.NewRequest(http.MethodPost, "/api/internal/orient", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("got %d %s", rr.Code, rr.Body.String())
	}
	var decoded struct {
		Bucket          string  `json:"bucket"`
		SummarySentence *string `json:"summarySentence"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Bucket != "debug_failure" || decoded.SummarySentence == nil {
		t.Fatalf("unexpected decision %s", rr.Body.String())
	}

	// Orient is classify-only: no tools, no streaming, and fully deterministic.
	if client.req.Tools != nil || client.req.Stream {
		t.Fatalf("orient must be a non-streaming, tool-free call: %#v", client.req)
	}
	if client.req.Temperature != 0 || client.req.TopP != 1 {
		t.Fatalf("orient must be deterministic: %#v", client.req)
	}
	// No output cap and no forced reasoning effort: the model decides how much
	// to think. Every cap tried was blown by a thinking-by-default model
	// reasoning inside the budget and returning an empty content.
	if client.req.MaxOutputTokens != 0 {
		t.Fatalf("orient must not cap the output, got %d", client.req.MaxOutputTokens)
	}
	if client.req.ReasoningEffort != model.ReasoningNone || client.req.ThinkingTokenBudget != nil || client.req.ParallelTools {
		t.Fatalf("orient must not force a reasoning effort or parallelize: %#v", client.req)
	}
	// The harness constrains the shape instead: whatever content arrives can
	// only be one decision object.
	if client.req.ResponseSchema == nil {
		t.Fatalf("orient must constrain the response schema: %#v", client.req)
	}
	if len(client.req.Messages) != 2 || client.req.Messages[0].Role != "system" {
		t.Fatalf("orient must send exactly the server prompt plus the bounded input: %#v", client.req.Messages)
	}
	// The admission lease is released, so the next request is admitted.
	rr2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/internal/orient", strings.NewReader(body))
	req2.Header.Set("Authorization", "Bearer test-token")
	server.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Fatalf("admission lease was not released: %d", rr2.Code)
	}
}

func TestOrientRouteNullsTheSummaryForDirectAnswerAndInvalidSentences(t *testing.T) {
	post := func(content string) *httptest.ResponseRecorder {
		cfg := testConfig()
		cfg.ContextLength = 64_000
		server := NewServer(cfg, &fakeModelClient{chatContent: content})
		req := httptest.NewRequest(http.MethodPost, "/api/internal/orient",
			strings.NewReader(`{"route":"engineering/chat","requestText":"what can you do?"}`))
		req.Header.Set("Authorization", "Bearer test-token")
		rr := httptest.NewRecorder()
		server.ServeHTTP(rr, req)
		return rr
	}

	rr := post(`{"bucket":"direct_answer","summarySentence":"I'll just answer."}`)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"summarySentence":null`) {
		t.Fatalf("direct_answer must carry a null summary: %d %s", rr.Code, rr.Body.String())
	}

	// An invalid sentence costs only the sentence, and nothing stands in for
	// it: the opening status line is model-written or absent. The response
	// grammar is what makes absence rare — the schema requires the sentence
	// as a string — so a null here models an older or degraded runtime.
	for _, content := range []string{
		`{"bucket":"code_change","summarySentence":null}`,
		`{"bucket":"code_change","summarySentence":"Running deep_review now."}`,
		`{"bucket":"code_change","summarySentence":"no terminator"}`,
	} {
		kept := post(content)
		if kept.Code != http.StatusOK ||
			!strings.Contains(kept.Body.String(), `"bucket":"code_change"`) ||
			!strings.Contains(kept.Body.String(), `"summarySentence":null`) {
			t.Fatalf("output %q must keep the bucket with a null summary: %d %s", content, kept.Code, kept.Body.String())
		}
	}

	// A valid sentence survives as written.
	own := post(`{"bucket":"code_change","summarySentence":"I'll add the retry wrapper and verify it."}`)
	if !strings.Contains(own.Body.String(), `"summarySentence":"I'll add the retry wrapper and verify it."`) {
		t.Fatalf("a valid sentence must survive: %s", own.Body.String())
	}

	// A fenced decision from a local model is normalized, not degraded.
	fenced := post("```json\n{\"bucket\":\"code_change\",\"summarySentence\":\"I'll make the change and verify it.\"}\n```")
	if fenced.Code != http.StatusOK || !strings.Contains(fenced.Body.String(), `"bucket":"code_change"`) {
		t.Fatalf("fenced output must normalize: %d %s", fenced.Code, fenced.Body.String())
	}

	// A broken envelope still invalidates the whole decision, and the response
	// names a static reason so the runner's degraded diagnostic can carry it.
	bad := post("I think this is a code change.")
	if bad.Code != http.StatusBadGateway || !strings.Contains(bad.Body.String(), "invalid_orient_decision") {
		t.Fatalf("unparseable output must be rejected: %d %s", bad.Code, bad.Body.String())
	}
	if !strings.Contains(bad.Body.String(), `"reason":"output is not one JSON object`) {
		t.Fatalf("rejection must name a reason: %s", bad.Body.String())
	}
}

// The runner refuses a tool-less answer in buckets whose answer must rest on
// tool results, but the catalog decides which those are. The flag has to travel
// with the decision, resolved, so the runner never carries a second copy of the
// catalog and the two can never disagree.
func TestOrientRouteReportsTheBucketsEvidenceRequirement(t *testing.T) {
	decide := func(content string) map[string]any {
		cfg := testConfig()
		cfg.ContextLength = 64_000
		server := NewServer(cfg, &fakeModelClient{chatContent: content})
		req := httptest.NewRequest(http.MethodPost, "/api/internal/orient",
			strings.NewReader(`{"route":"engineering/chat","requestText":"tell me about this codebase","previousResponse":""}`))
		req.Header.Set("Authorization", "Bearer test-token")
		rr := httptest.NewRecorder()
		server.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("got %d %s", rr.Code, rr.Body.String())
		}
		var decoded map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &decoded); err != nil {
			t.Fatal(err)
		}
		return decoded
	}

	guided := decide(`{"bucket":"repo_orient","summarySentence":"I will map this repository and read its docs."}`)
	if guided["evidenceRequired"] != true {
		t.Fatalf("repo_orient must require evidence: %v", guided)
	}

	// Ending on questions is the correct outcome here, so the rule stays off.
	asking := decide(`{"bucket":"spec_discovery","summarySentence":"I will ask a few questions first."}`)
	if asking["evidenceRequired"] != false {
		t.Fatalf("spec_discovery must not require evidence: %v", asking)
	}

	direct := decide(`{"bucket":"direct_answer","summarySentence":null}`)
	if direct["evidenceRequired"] != false {
		t.Fatalf("direct_answer must not require evidence: %v", direct)
	}

	// The envelope stays closed: exactly these three keys, so the runner's
	// strict key check keeps rejecting anything else.
	if len(guided) != 3 {
		t.Fatalf("orient response must carry exactly bucket, summarySentence, and evidenceRequired: %v", guided)
	}
}

func TestOrientRouteRejectsInvalidRequestsAndWrongMethods(t *testing.T) {
	cfg := testConfig()
	server := NewServer(cfg, &fakeModelClient{})
	for name, body := range map[string]string{
		"bare profile route": `{"route":"engineering","requestText":"hi"}`,
		"blank text":         `{"route":"engineering/chat","requestText":"  "}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/internal/orient", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer test-token")
		rr := httptest.NewRecorder()
		server.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "invalid_orient_request") {
			t.Fatalf("%s: got %d %s", name, rr.Code, rr.Body.String())
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/api/internal/orient", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("orient must be POST-only: %d", rr.Code)
	}
}

func TestChatRouteRendersTheVeilOwnedPlaybookLastAndOnlyWhenSelected(t *testing.T) {
	cfg := testConfig()
	cfg.ContextLength = 64_000
	skills := `[{"id":"umbratic-security-review","name":"Security Review","description":"Security review.","source":"system"}]`

	// Without a selector the assembly is exactly today's shape.
	plainClient := &fakeModelClient{}
	plainServer := NewServer(cfg, plainClient)
	plainReq := httptest.NewRequest(http.MethodPost, "/api/engineering/chat",
		strings.NewReader(`{"messages":[{"role":"user","content":"audit the auth code"}],"skills":`+skills+`}`))
	plainReq.Header.Set("Authorization", "Bearer test-token")
	plainServer.ServeHTTP(httptest.NewRecorder(), plainReq)
	baseline := plainClient.req.Messages
	for _, message := range baseline {
		if content, _ := message.Content.(string); strings.Contains(content, "Active task playbook") {
			t.Fatal("a run with no selector must carry no playbook")
		}
	}

	guidedClient := &fakeModelClient{}
	guidedServer := NewServer(cfg, guidedClient)
	guidedReq := httptest.NewRequest(http.MethodPost, "/api/engineering/chat",
		strings.NewReader(`{"messages":[{"role":"user","content":"audit the auth code"}],"skills":`+skills+`,"harness_bucket":"deep_review"}`))
	guidedReq.Header.Set("Authorization", "Bearer test-token")
	guidedServer.ServeHTTP(httptest.NewRecorder(), guidedReq)
	guided := guidedClient.req.Messages

	if len(guided) != len(baseline)+1 {
		t.Fatalf("a selector must add exactly one protected message: %d vs %d", len(guided), len(baseline))
	}
	playbook, _ := guided[len(guided)-2].Content.(string)
	if !strings.Contains(playbook, "Your task playbook for this turn.") {
		t.Fatalf("playbook must be the last protected message, got %q", playbook)
	}
	if !strings.Contains(playbook, "umbratic-security-review") {
		t.Fatal("an enabled preferred skill must be named in the playbook")
	}
	if guided[len(guided)-1].Role != "user" {
		t.Fatal("client messages must follow the playbook")
	}
	// Everything before the playbook is byte-stable, so only the playbook slot
	// invalidates the prefix cache.
	for i := 0; i < len(baseline)-1; i++ {
		if baseline[i].Content != guided[i].Content {
			t.Fatalf("protected prefix segment %d changed when a playbook was added", i)
		}
	}
}

func TestChatRouteDefaultsAnUnknownOrCrossRouteBucketSelector(t *testing.T) {
	// A selector this build cannot resolve is a hint from a newer harness. The
	// run proceeds with no playbook rather than failing, which is byte-identical
	// to a request that carried no selector at all.
	cfg := testConfig()
	for name, bucket := range map[string]string{
		"unknown":     "not_a_bucket",
		"cross route": "campaign_plan",
		"direct":      "direct_answer",
	} {
		client := &fakeModelClient{}
		server := NewServer(cfg, client)
		req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat",
			strings.NewReader(`{"input":"hello","harness_bucket":"`+bucket+`"}`))
		req.Header.Set("Authorization", "Bearer test-token")
		rr := httptest.NewRecorder()
		server.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s selector must be accepted: %d %s", name, rr.Code, rr.Body.String())
		}
		for _, message := range client.req.Messages {
			if content, _ := message.Content.(string); strings.Contains(content, "Active task playbook") {
				t.Fatalf("%s selector must not select a playbook", name)
			}
		}
	}
}

func TestOrientRouteIsRefusedWhileDraining(t *testing.T) {
	cfg := testConfig()
	client := &fakeModelClient{chatContent: `{"bucket":"direct_answer","summarySentence":null}`}
	server := NewServer(cfg, client)
	server.lifecycle.markReady()
	server.lifecycle.beginDrain()
	req := httptest.NewRequest(http.MethodPost, "/api/internal/orient",
		strings.NewReader(`{"route":"engineering/chat","requestText":"hello"}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)
	if rr.Code != http.StatusServiceUnavailable || !strings.Contains(rr.Body.String(), "draining") {
		t.Fatalf("orient must be gated by lifecycle like other model work: %d %s", rr.Code, rr.Body.String())
	}
	if len(client.req.Messages) != 0 {
		t.Fatal("orient reached the model while draining")
	}
}
