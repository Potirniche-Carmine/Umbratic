package httpapi

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestChatUsesRemainingContextForOutput(t *testing.T) {
	cfg := testConfig()
	cfg.ContextLength = 65536
	cfg.MaxOutputTokens = 8192
	call := func(client *fakeModelClient) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hey there","max_output_tokens":8192}`))
		request.Header.Set("Authorization", "Bearer test-token")
		response := httptest.NewRecorder()
		NewServer(cfg, client).ServeHTTP(response, request)
		return response
	}
	baseline := &fakeModelClient{}
	if response := call(baseline); response.Code != http.StatusOK {
		t.Fatalf("baseline: %d %s", response.Code, response.Body.String())
	}
	estimated, _ := finalRequestFits(baseline.req, cfg.ContextLength)
	promptTokens := estimated - baseline.req.MaxOutputTokens
	for _, available := range []int{8192, 2000, 1000, 999, 0} {
		cfg.ContextLength = promptTokens + available
		client := &fakeModelClient{}
		response := call(client)
		if available < 1000 {
			if response.Code != http.StatusRequestEntityTooLarge || len(client.req.Messages) != 0 {
				t.Fatalf("%d remaining tokens admitted an oversized request: %d", available, response.Code)
			}
			continue
		}
		if response.Code != http.StatusOK || client.req.MaxOutputTokens != available {
			t.Fatalf("%d remaining tokens: status %d, output budget %d", available, response.Code, client.req.MaxOutputTokens)
		}
		if !reflect.DeepEqual(client.req.Messages, baseline.req.Messages) {
			t.Fatal("fitting output changed the prompt")
		}
		if _, fits := finalRequestFits(client.req, cfg.ContextLength); !fits {
			t.Fatal("request exceeded the configured context window")
		}
	}
}
