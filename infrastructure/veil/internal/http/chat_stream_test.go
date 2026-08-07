package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"umbratic-veil/internal/model"
)

func (f *fakeModelClient) PrefixTokens(_ context.Context, _, _ string, messages []model.Message) model.UsageAnnotation {
	f.prefixTokenCalls++
	if len(messages) == 0 {
		return model.UsageAnnotation{}
	}
	return model.UsageAnnotation{SystemPromptTokens: 3187, Exact: true}
}

func TestChatRouteReportsItsOwnProtectedPrefixSize(t *testing.T) {
	modelClient := &fakeModelClient{
		streamContentType: "application/x-ndjson",
		streamBody: strings.Join([]string{
			`{"message":{"role":"assistant","content":"hello"},"done":true,"prompt_eval_count":1234,"eval_count":56}`,
			"",
		}, "\n"),
	}
	cfg := testConfig()
	cfg.Mode = model.ModeLocal
	server := NewServer(cfg, modelClient)

	req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"messages":[{"role":"user","content":"hello"}],"stream":true}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	if modelClient.prefixTokenCalls != 1 {
		t.Fatalf("the assembled prefix must be sized once per request, got %d", modelClient.prefixTokenCalls)
	}
	body := rr.Body.String()
	if !strings.Contains(body, `"system_prompt_tokens":3187`) {
		t.Fatalf("the usage frame did not carry the protected prefix size: %q", body)
	}
	// The size of the protected prefix is not the prefix. Nothing about the
	// prompt text itself may reach the client.
	if strings.Contains(body, "You are Umbratic") || strings.Contains(body, "Route: engineering chat") {
		t.Fatalf("protected prompt text leaked into the stream: %q", body)
	}
}
