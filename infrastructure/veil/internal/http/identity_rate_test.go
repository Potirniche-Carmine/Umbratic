package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"umbratic-veil/internal/config"
	"umbratic-veil/internal/entitlement"
	"umbratic-veil/internal/identity"
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

func TestIdentityRateKeyUsesTheClosestUntrustedHop(t *testing.T) {
	forwarded := func(server *Server, remoteAddr string, header string) string {
		request := httptest.NewRequest(http.MethodPost, "/api/session/challenge", strings.NewReader(`{}`))
		request.RemoteAddr = remoteAddr
		if header != "" {
			request.Header.Set("X-Forwarded-For", header)
		}
		return server.clientAddress(request)
	}

	// Default: no trusted proxy, so the header is ignored entirely.
	untrusting := &Server{identityRate: &identityRateLimiter{entries: map[string]rateEntry{}}}
	if got := forwarded(untrusting, "127.0.0.1:52000", "203.0.113.9"); got != "127.0.0.1" {
		t.Fatalf("unconfigured deployment believed a forged header: %s", got)
	}

	trusting := &Server{
		cfg: config.Config{TrustedProxyCIDRs: []netip.Prefix{
			netip.MustParsePrefix("127.0.0.1/32"),
			netip.MustParsePrefix("::1/128"),
		}},
		identityRate: &identityRateLimiter{entries: map[string]rateEntry{}},
	}
	cases := []struct{ remote, header, want string }{
		// Caddy overwrites the header, so a single entry is the real client.
		{"127.0.0.1:52000", "203.0.113.9", "203.0.113.9"},
		// Defense in depth if it ever appends: take the right-most hop.
		{"127.0.0.1:52000", "10.0.0.1, 203.0.113.9", "203.0.113.9"},
		{"127.0.0.1:52000", "", "127.0.0.1"},
		{"127.0.0.1:52000", "not-an-address", "127.0.0.1"},
		// An untrusted peer never gets to choose its own bucket.
		{"198.51.100.4:52000", "203.0.113.9", "198.51.100.4"},
	}
	for _, testCase := range cases {
		if got := forwarded(trusting, testCase.remote, testCase.header); got != testCase.want {
			t.Fatalf("remote %q header %q: got %q, want %q", testCase.remote, testCase.header, got, testCase.want)
		}
	}

	// Distinct clients must not share a bucket.
	if trusting.identityRateKey(mustRequest("127.0.0.1:1", "203.0.113.9"), "enroll") ==
		trusting.identityRateKey(mustRequest("127.0.0.1:2", "203.0.113.10"), "enroll") {
		t.Fatal("two clients behind the proxy shared one rate-limit bucket")
	}
}

func mustRequest(remoteAddr, forwarded string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/enrollment/enroll", strings.NewReader(`{}`))
	request.RemoteAddr = remoteAddr
	request.Header.Set("X-Forwarded-For", forwarded)
	return request
}

// Both unauthenticated session routes are bounded; before this they were not.
func TestSessionRoutesAreRateLimited(t *testing.T) {
	for _, route := range []string{"/api/session", "/api/session/logout"} {
		store, err := identity.Open(filepath.Join(t.TempDir(), "identity.json"), entitlement.Payload{
			Version: 1, OrgUID: "org_test", MaxAuthorizedUsers: 1, MaxDevicesPerUser: 1,
		})
		if err != nil {
			t.Fatalf("open identity store: %v", err)
		}
		server := &Server{identity: store, identityRate: &identityRateLimiter{entries: map[string]rateEntry{}}}
		var lastCode int
		for range 31 {
			request := httptest.NewRequest(http.MethodPost, route, strings.NewReader(`{`))
			recorder := httptest.NewRecorder()
			if !server.handleCompanyIdentityRoute(recorder, request) {
				t.Fatalf("%s was not handled", route)
			}
			lastCode = recorder.Code
		}
		if lastCode != http.StatusTooManyRequests {
			t.Fatalf("%s attempt 31 was not rate limited: got %d", route, lastCode)
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
