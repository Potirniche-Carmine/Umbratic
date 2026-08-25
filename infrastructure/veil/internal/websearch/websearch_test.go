package websearch

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := NewClient("subscription-secret", 5*time.Second)
	client.endpoint = server.URL
	// The gate starts a full spacing interval in the past so a test does not
	// pay the 1 QPS wait for its first call.
	<-client.gate
	client.gate <- time.Now().Add(-2 * minSpacing)
	return client
}

func TestSearchSendsSubscriptionTokenAndBoundedQuery(t *testing.T) {
	var gotToken, gotQuery, gotCount, gotAuthorization string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Subscription-Token")
		gotAuthorization = r.Header.Get("Authorization")
		gotQuery = r.URL.Query().Get("q")
		gotCount = r.URL.Query().Get("count")
		_, _ = w.Write([]byte(`{"web":{"results":[{"title":"Ada","url":"https://example.com/a","description":"first"}]}}`))
	})
	results, err := client.Search(t.Context(), "quarterly filings")
	if err != nil {
		t.Fatalf("search failed: %v", err)
	}
	if gotToken != "subscription-secret" {
		t.Fatalf("subscription token was not sent: %q", gotToken)
	}
	if gotAuthorization != "" {
		t.Fatalf("the token must travel in its own header only, not as %q", gotAuthorization)
	}
	if gotQuery != "quarterly filings" || gotCount != "5" {
		t.Fatalf("unexpected request q=%q count=%q", gotQuery, gotCount)
	}
	if len(results) != 1 || results[0].Title != "Ada" || results[0].Snippet != "first" {
		t.Fatalf("unexpected results: %#v", results)
	}
}

func TestSearchErrorsNeverCarryTheQueryOrTheToken(t *testing.T) {
	for _, trial := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"upstream refused", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"bad token subscription-secret for q=confidential merger"}`))
		}},
		{"upstream answered with a captcha page", func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("<html><body>prove you are human</body></html>"))
		}},
	} {
		t.Run(trial.name, func(t *testing.T) {
			client := newTestClient(t, trial.handler)
			results, err := client.Search(t.Context(), "confidential merger")
			if err == nil {
				t.Fatalf("expected a failure, got %#v", results)
			}
			if strings.Contains(err.Error(), "confidential merger") || strings.Contains(err.Error(), "subscription-secret") {
				t.Fatalf("the error leaked the query or the token: %q", err)
			}
		})
	}
}

// An unparseable body is a failure, not an empty result set: a model told "no
// hits" concludes the subject is absent from the web and invents a domain.
func TestUnparseableBodyIsNotAnEmptyResultSet(t *testing.T) {
	if _, err := parseResults([]byte("<html>rate limited</html>")); err == nil {
		t.Fatal("an HTML interstitial parsed as a valid empty result set")
	}
	results, err := parseResults([]byte(`{"query":{"original":"x"}}`))
	if err != nil || len(results) != 0 {
		t.Fatalf("a well-formed answer with no web block must be zero hits: %#v %v", results, err)
	}
}

func TestParseResultsCapsAndFiltersPrivateHosts(t *testing.T) {
	body := `{"web":{"results":[
		{"title":"router","url":"http://192.168.1.1/admin","description":"internal"},
		{"title":"loopback","url":"http://127.0.0.1:8080/","description":"internal"},
		{"title":"metadata","url":"http://metadata.google.internal/computeMetadata/v1/","description":"internal"},
		{"title":"cgnat","url":"http://100.64.0.5/","description":"internal"},
		{"title":"mapped","url":"http://[::ffff:10.0.0.1]/","description":"internal"},
		{"title":"credentialed","url":"https://user:pass@example.com/","description":"internal"},
		{"title":"file","url":"file:///etc/passwd","description":"internal"},
		{"title":"one","url":"https://example.com/1","description":"a  b\nc"},
		{"title":"two","url":"https://example.com/2","description":""},
		{"title":"three","url":"https://example.com/3","description":""},
		{"title":"four","url":"https://example.com/4","description":""},
		{"title":"five","url":"https://example.com/5","description":""},
		{"title":"six","url":"https://example.com/6","description":""}
	]}}`
	results, err := parseResults([]byte(body))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(results) != MaxResults {
		t.Fatalf("expected %d results, got %d: %#v", MaxResults, len(results), results)
	}
	for _, result := range results {
		if !strings.HasPrefix(result.URL, "https://example.com/") {
			t.Fatalf("a non-public host survived the filter: %q", result.URL)
		}
	}
	if results[0].Snippet != "a b c" {
		t.Fatalf("snippet whitespace was not collapsed: %q", results[0].Snippet)
	}
}

func TestPublicHTTPURL(t *testing.T) {
	for _, trial := range []struct {
		url    string
		public bool
	}{
		{"https://example.com/page", true},
		{"http://93.184.216.34/", true},
		{"https://EXAMPLE.com./page", true},
		{"http://localhost/", false},
		{"http://LOCALHOST:9000/", false},
		{"http://metadata/", false},
		{"http://metadata.tencentyun.com/", false},
		{"http://10.0.0.1/", false},
		{"http://172.16.0.1/", false},
		{"http://169.254.169.254/", false},
		{"http://0.0.0.0/", false},
		{"http://255.255.255.255/", false},
		{"http://198.51.100.7/", false},
		{"http://[fd00::1]/", false},
		{"http://[::1]/", false},
		{"ftp://example.com/", false},
		{"not a url at all", false},
		{"", false},
	} {
		if got := publicHTTPURL(trial.url); got != trial.public {
			t.Fatalf("publicHTTPURL(%q) = %v, want %v", trial.url, got, trial.public)
		}
	}
}

// The whole organization's searches funnel through one subscription, so the
// gate has to hold overlapping calls apart and space them, rather than let one
// turn's parallel tool calls burst the credit plan.
func TestConcurrentSearchesAreSerializedAndSpaced(t *testing.T) {
	inFlight := make(chan struct{}, 1)
	var overlapped atomic.Bool
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case inFlight <- struct{}{}:
		default:
			overlapped.Store(true)
		}
		time.Sleep(5 * time.Millisecond)
		<-inFlight
		_, _ = w.Write([]byte(`{"web":{"results":[]}}`))
	})
	started := time.Now()
	done := make(chan struct{}, 2)
	for range 2 {
		go func() {
			_, _ = client.Search(t.Context(), "query")
			done <- struct{}{}
		}()
	}
	for range 2 {
		<-done
	}
	if overlapped.Load() {
		t.Fatal("two searches were in flight at once")
	}
	if elapsed := time.Since(started); elapsed < minSpacing {
		t.Fatalf("two searches finished in %s, inside the %s spacing", elapsed, minSpacing)
	}
}

func TestSearchGivesUpWhenTheContextEnds(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"web":{"results":[]}}`))
	})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := client.Search(ctx, "query"); err == nil {
		t.Fatal("a canceled request still returned results")
	}
	// The gate must have been handed back, or every later search would block.
	select {
	case last := <-client.gate:
		client.gate <- last
	default:
		t.Fatal("the canceled call kept the gate")
	}
}

func TestKeyPrefersTheDevelopmentOverride(t *testing.T) {
	t.Setenv("VEIL_WEB_SEARCH_API_KEY", "  from-environment  ")
	if got := Key(); got != "from-environment" {
		t.Fatalf("the override was not used: %q", got)
	}
	t.Setenv("VEIL_WEB_SEARCH_API_KEY", "")
	if got := Key(); got != "" {
		t.Fatalf("a build with no baked key must have no key: %q", got)
	}
}
