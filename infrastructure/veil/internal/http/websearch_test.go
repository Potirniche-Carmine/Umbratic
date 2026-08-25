package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"umbratic-veil/internal/config"
	"umbratic-veil/internal/websearch"
)

type fakeWebSearch struct {
	results []websearch.Result
	err     error
	calls   int
	queries []string
}

func (f *fakeWebSearch) Search(_ context.Context, query string) ([]websearch.Result, error) {
	f.calls++
	f.queries = append(f.queries, query)
	return f.results, f.err
}

// searchServer wires a server whose search backend answers locally. Company
// identity mode is on because that is where the monthly pool exists; the route
// is driven directly so a test of quotas and bounds does not have to enroll a
// device first.
func searchServer(t *testing.T, monthlyLimit int, backend WebSearchClient) *Server {
	t.Helper()
	cfg := testConfig()
	cfg.CompanyIdentityMode = true
	ledger, err := websearch.OpenLedger(filepath.Join(t.TempDir(), "web-search-usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{cfg: cfg, webSearch: backend, webSearchUsage: ledger}
	server.license.MaxSearchesPerMonth = monthlyLimit
	return server
}

func searchRequest(t *testing.T, server *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	server.handleWebSearch(recorder, httptest.NewRequest(http.MethodPost, "/api/web/search", strings.NewReader(body)))
	return recorder
}

func codeOf(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("response is not a coded error: %s", recorder.Body.String())
	}
	return payload.Code
}

func TestWebSearchReturnsBoundedResults(t *testing.T) {
	backend := &fakeWebSearch{results: []websearch.Result{
		{Title: "Filing", URL: "https://example.com/10-k", Snippet: "annual report"},
	}}
	recorder := searchRequest(t, searchServer(t, 10, backend), `{"query":"  example annual report  "}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("search failed: %d %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Results []websearch.Result `json:"results"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Results) != 1 || payload.Results[0].URL != "https://example.com/10-k" {
		t.Fatalf("unexpected results: %#v", payload.Results)
	}
	if backend.queries[0] != "example annual report" {
		t.Fatalf("the query reached the backend untrimmed: %q", backend.queries[0])
	}
}

// The runner's catalog bounds the query far below this. Veil's cap is the
// boundary check, so it is tested for what it refuses rather than for what a
// well-behaved client sends.
func TestWebSearchRejectsMalformedAndOutOfBoundsBodies(t *testing.T) {
	for _, trial := range []struct {
		name string
		body string
	}{
		{"not JSON", `{`},
		{"empty body", ``},
		{"a JSON array", `["example"]`},
		{"no query", `{}`},
		{"blank query", `{"query":"   "}`},
		{"wrong type", `{"query":42}`},
		{"over the cap", `{"query":"` + strings.Repeat("a", 513) + `"}`},
		{"newline in the query", "{\"query\":\"example\\nHost: internal\"}"},
		{"null byte in the query", "{\"query\":\"example\\u0000\"}"},
	} {
		t.Run(trial.name, func(t *testing.T) {
			backend := &fakeWebSearch{}
			recorder := searchRequest(t, searchServer(t, 10, backend), trial.body)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("got %d %s", recorder.Code, recorder.Body.String())
			}
			if backend.calls != 0 {
				t.Fatal("a refused body still reached the search backend")
			}
		})
	}
}

// A newer harness may carry search hints this build has never seen. Unknown
// fields are stripped, never refused.
func TestWebSearchAcceptsUnknownFields(t *testing.T) {
	backend := &fakeWebSearch{}
	recorder := searchRequest(t, searchServer(t, 10, backend), `{"query":"example","freshness":"pd","site":"example.com"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("a future harness body was refused: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestWebSearchIsAbsentWithoutAKeyOrAnAllowance(t *testing.T) {
	for _, trial := range []struct {
		name    string
		limit   int
		backend WebSearchClient
	}{
		{"no subscription key in this build", 10, nil},
		{"the organization bought no searches", 0, &fakeWebSearch{}},
	} {
		t.Run(trial.name, func(t *testing.T) {
			recorder := searchRequest(t, searchServer(t, trial.limit, trial.backend), `{"query":"example"}`)
			if recorder.Code != http.StatusNotFound || codeOf(t, recorder) != "web_search_unconfigured" {
				t.Fatalf("got %d %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

// The unit is taken before the call and never refunded: the provider bills the
// request either way, so a retry loop must not be free to the organization.
func TestWebSearchSpendsTheMonthlyPoolOnFailuresToo(t *testing.T) {
	backend := &fakeWebSearch{err: context.DeadlineExceeded}
	server := searchServer(t, 2, backend)
	for attempt := range 2 {
		recorder := searchRequest(t, server, `{"query":"example"}`)
		if recorder.Code != http.StatusBadGateway || codeOf(t, recorder) != "web_search_unavailable" {
			t.Fatalf("attempt %d: got %d %s", attempt, recorder.Code, recorder.Body.String())
		}
	}
	recorder := searchRequest(t, server, `{"query":"example"}`)
	if recorder.Code != http.StatusTooManyRequests || codeOf(t, recorder) != "web_search_quota_exhausted" {
		t.Fatalf("two failed searches did not spend a pool of two: %d %s", recorder.Code, recorder.Body.String())
	}
	if backend.calls != 2 {
		t.Fatalf("the exhausted month still called upstream: %d calls", backend.calls)
	}
}

// Veil answers a search failure with its own coded error and nothing else. The
// upstream's words can carry the query back, and the query is the user's.
func TestWebSearchFailureLeaksNothing(t *testing.T) {
	backend := &fakeWebSearch{err: &leakyError{}}
	recorder := searchRequest(t, searchServer(t, 10, backend), `{"query":"acquisition of Northwind"}`)
	body := recorder.Body.String()
	for _, secret := range []string{"acquisition of Northwind", "subscription-secret", "api.search.brave.com"} {
		if strings.Contains(body, secret) {
			t.Fatalf("the response leaked %q: %s", secret, body)
		}
	}
}

type leakyError struct{}

func (*leakyError) Error() string {
	return "Get \"https://api.search.brave.com/res/v1/web/search?q=acquisition+of+Northwind\": token subscription-secret rejected"
}

func TestWebSearchMonthlyLimitFollowsTheEntitlement(t *testing.T) {
	server := searchServer(t, 500, &fakeWebSearch{})
	if got := server.webSearchMonthlyLimit(); got != 500 {
		t.Fatalf("the purchased pool was not read from the entitlement: %d", got)
	}
	if !server.webSearchAvailable() {
		t.Fatal("a keyed server with an unspent pool must advertise the feature")
	}
	// Shared-token mode has no entitlement document, so it has no cap. That
	// mode is development only; the per-user rate limit still applies.
	server.cfg.CompanyIdentityMode = false
	if got := server.webSearchMonthlyLimit(); got != websearch.Unmetered {
		t.Fatalf("shared-token mode was metered: %d", got)
	}
}

func TestWebSearchFeatureIsWithdrawnWhenTheMonthIsSpent(t *testing.T) {
	server := searchServer(t, 1, &fakeWebSearch{})
	if !server.webSearchAvailable() {
		t.Fatal("an unspent pool must advertise web.search")
	}
	if recorder := searchRequest(t, server, `{"query":"example"}`); recorder.Code != http.StatusOK {
		t.Fatalf("the only search was refused: %d %s", recorder.Code, recorder.Body.String())
	}
	if server.webSearchAvailable() {
		t.Fatal("a spent month kept advertising web.search")
	}
	// A build with no key never advertises it, whatever the entitlement says.
	server.webSearch = nil
	if server.webSearchAvailable() {
		t.Fatal("a keyless build advertised web.search")
	}
}

// The route lives on ServeHTTP's product path: session-authenticated, POST
// only, and rate limited on its own budget rather than the model's.
func TestWebSearchRouteIsAuthenticatedPostOnlyAndRateLimited(t *testing.T) {
	cfg := testConfig()
	cfg.WebSearchRequestsPerMinute = 2
	server := NewServer(cfg, &fakeModelClient{})
	ledger, err := websearch.OpenLedger(filepath.Join(t.TempDir(), "web-search-usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	backend := &fakeWebSearch{}
	server.webSearch, server.webSearchUsage = backend, ledger

	unauthenticated := httptest.NewRequest(http.MethodPost, "/api/web/search", strings.NewReader(`{"query":"example"}`))
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, unauthenticated)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("an unauthenticated search was served: %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	server.ServeHTTP(recorder, authorizedRequest(http.MethodGet, "/api/web/search", ""))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET was served: %d %s", recorder.Code, recorder.Body.String())
	}

	for attempt := range 3 {
		recorder = httptest.NewRecorder()
		server.ServeHTTP(recorder, authorizedRequest(http.MethodPost, "/api/web/search", `{"query":"example"}`))
		if attempt < 2 && recorder.Code != http.StatusOK {
			t.Fatalf("search %d inside the rate limit failed: %d %s", attempt, recorder.Code, recorder.Body.String())
		}
		if attempt == 2 {
			if recorder.Code != http.StatusTooManyRequests || codeOf(t, recorder) != "rate_limited" {
				t.Fatalf("the third search was not rate limited: %d %s", recorder.Code, recorder.Body.String())
			}
			if recorder.Header().Get("Retry-After") == "" {
				t.Fatal("a rate-limited search did not say how long to wait")
			}
		}
	}
	// Searches must not spend the model budget: a research-heavy turn still has
	// its full allowance of generations.
	if allowed, _ := server.modelQuota.allow("127.0.0.1", time.Now()); !allowed {
		t.Fatal("searching spent the model quota")
	}
}

func TestWebSearchIsAbsentFromHealthWithoutAKey(t *testing.T) {
	t.Setenv("VEIL_WEB_SEARCH_API_KEY", "")
	server := NewServer(testConfig(), &fakeModelClient{})
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, authorizedRequest(http.MethodGet, "/api/health", ""))
	var payload struct {
		Features []string `json:"features"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, name := range payload.Features {
		if name == "web.search" {
			t.Fatalf("a build with no subscription key advertised web.search: %#v", payload.Features)
		}
	}
}

// Config carries the ledger path and the search rate; the server reads both.
func TestWebSearchLimiterFollowsConfiguration(t *testing.T) {
	for _, trial := range []struct {
		perMinute int
		limited   bool
	}{
		{0, false},
		{1, true},
	} {
		cfg := config.Config{WebSearchRequestsPerMinute: trial.perMinute}
		server := NewServer(cfg, &fakeModelClient{})
		if (server.webSearchQuota != nil) != trial.limited {
			t.Fatalf("VEIL_WEB_SEARCH_REQUESTS_PER_MINUTE=%d built the wrong limiter", trial.perMinute)
		}
	}
}
