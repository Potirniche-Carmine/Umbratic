package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUnconfiguredServerIsLiveAndAuthenticated(t *testing.T) {
	cfg := testConfig()
	cfg.DefaultModel = ""
	server := NewServer(cfg, &fakeModelClient{})
	for _, tc := range []struct {
		path, method, token string
		status              int
		body                string
	}{
		{"/livez", "GET", "", 200, "ok"},
		{"/api/health", "GET", "test-token", 200, "model_not_configured"},
		{"/api/models", "GET", "test-token", 200, `"models":[]`},
		{"/api/engineering/chat", "POST", "test-token", 503, "model_not_configured"},
		{"/api/engineering/chat", "POST", "", 401, "unauthorized"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		if tc.token != "" {
			req.Header.Set("Authorization", "Bearer "+tc.token)
		}
		rr := httptest.NewRecorder()
		server.ServeHTTP(rr, req)
		if rr.Code != tc.status || !strings.Contains(rr.Body.String(), tc.body) {
			t.Fatalf("%s: %d %s", tc.path, rr.Code, rr.Body.String())
		}
	}
}
