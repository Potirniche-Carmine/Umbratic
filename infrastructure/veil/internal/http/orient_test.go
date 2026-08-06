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
	body := `{"route":"engineering/chat","requestText":"the auth test is failing","previousBucket":"code_change"}`
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
	if client.req.MaxOutputTokens != orientMaxOutputTokens {
		t.Fatalf("orient output must be capped at %d, got %d", orientMaxOutputTokens, client.req.MaxOutputTokens)
	}
	if client.req.ReasoningEffort != model.ReasoningNone || client.req.ThinkingTokenBudget != nil || client.req.ParallelTools {
		t.Fatalf("orient must not reason, think, or parallelize: %#v", client.req)
	}
	// Local thinking-by-default models spend the whole bounded budget on
	// reasoning and return an empty content unless thinking is disabled and the
	// reply is grammar-constrained to the decision object.
	if !client.req.DisableThinking || client.req.ResponseSchema == nil {
		t.Fatalf("orient must disable thinking and constrain the response schema: %#v", client.req)
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

	// An invalid sentence costs only the sentence: the bucket still guides the
	// run, so the decision comes back with a null summary rather than failing.
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

func TestOrientRouteRejectsInvalidRequestsAndWrongMethods(t *testing.T) {
	cfg := testConfig()
	server := NewServer(cfg, &fakeModelClient{})
	for name, body := range map[string]string{
		"bare profile route": `{"route":"engineering","requestText":"hi"}`,
		"unknown field":      `{"route":"engineering/chat","requestText":"hi","messages":[]}`,
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
	if !strings.Contains(playbook, "Active task playbook") {
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

func TestChatRouteRejectsAnUnknownOrCrossRouteBucketSelector(t *testing.T) {
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
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("%s selector must be rejected: %d %s", name, rr.Code, rr.Body.String())
		}
		if len(client.req.Messages) != 0 {
			t.Fatalf("%s selector reached the model", name)
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
