package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIdentityRateLimitCountsAllAttempts(t *testing.T) {
	server := &Server{identityRate: &identityRateLimiter{entries: map[string]rateEntry{}}}
	request := httptest.NewRequest(http.MethodPost, "/api/session/challenge", strings.NewReader(`{}`))
	for attempt := range 31 {
		recorder := httptest.NewRecorder()
		allowed := server.allowIdentityRequest(recorder, request, "challenge", 30)
		if attempt < 30 && !allowed {
			t.Fatalf("attempt %d was blocked early: %d %s", attempt+1, recorder.Code, recorder.Body.String())
		}
		if attempt == 30 && (allowed || recorder.Code != http.StatusTooManyRequests) {
			t.Fatalf("attempt 31 was not blocked: %d %s", recorder.Code, recorder.Body.String())
		}
	}

	for attempt := range 11 {
		request = httptest.NewRequest(http.MethodPost, "/api/enrollment/enroll", strings.NewReader(`{`))
		recorder := httptest.NewRecorder()
		if !server.handleCompanyIdentityRoute(recorder, request) {
			t.Fatal("enrollment route was not handled")
		}
		if attempt < 10 && recorder.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d: got %d %s", attempt+1, recorder.Code, recorder.Body.String())
		}
		if attempt == 10 {
			if recorder.Code != http.StatusTooManyRequests {
				t.Fatalf("rate limit: got %d %s", recorder.Code, recorder.Body.String())
			}
			if recorder.Header().Get("Retry-After") != "60" {
				t.Fatal("rate limit response did not include Retry-After")
			}
		}
	}
}

func TestIdentityRateLimitRemovesExpiredKeysAtCapacity(t *testing.T) {
	entries := make(map[string]rateEntry, 4096)
	for index := range 4096 {
		entries[fmt.Sprintf("challenge|old-%d", index)] = rateEntry{
			window: time.Now().Add(-2 * time.Minute),
			count:  1,
		}
	}
	server := &Server{identityRate: &identityRateLimiter{entries: entries}}
	request := httptest.NewRequest(http.MethodPost, "/api/session/challenge", strings.NewReader(`{}`))
	recorder := httptest.NewRecorder()
	if !server.allowIdentityRequest(recorder, request, "challenge", 30) {
		t.Fatalf("new request was blocked by expired rate keys: %d %s", recorder.Code, recorder.Body.String())
	}
	if len(server.identityRate.entries) != 1 {
		t.Fatalf("expired rate keys were not removed: %d entries remain", len(server.identityRate.entries))
	}
}
