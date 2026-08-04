package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"umbratic-veil/internal/model"
)

func TestRuntimeMetricsRouteReturnsOnlySafeServingCounters(t *testing.T) {
	modelClient := &fakeModelClient{runtimeMetrics: model.RuntimeMetrics{
		PrefixCacheHitRate: 0.75,
		QueueDepth:         4,
		Available:          true,
	}}
	server := NewServer(testConfig(), modelClient)
	req := httptest.NewRequest(http.MethodGet, "/api/runtime/metrics", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["prefix_cache_hit_rate"] != 0.75 || body["runtime_queue_depth"] != float64(4) || body["runtime_state"] != "ready" {
		t.Fatalf("unexpected metrics body: %#v", body)
	}
	if body["admission_enabled"] != true || body["global_limit"] != float64(32) || body["active_requests"] != float64(0) {
		t.Fatalf("unexpected admission metrics: %#v", body)
	}
	// The payload is asserted by exact key set rather than by scanning for
	// suspicious substrings: token *counts* are a required metric, and an exact
	// set catches any new field — leaked or not — instead of only known-bad words.
	expected := []string{
		"active_requests", "admission_enabled", "cancel_count", "global_limit",
		"invalid_stream_count", "output_tokens_total", "overload_count", "per_user_limit",
		"prefix_cache_hit_rate", "prompt_tokens_total", "provider_retry_count", "queue_depth",
		"queue_timeout_ms", "queue_wait_ms_avg", "release_error_count", "runtime_queue_depth",
		"runtime_state", "stream_disconnects", "stream_ms_p50", "stream_ms_p95", "stream_ms_p99",
		"stream_samples", "timeout_count", "tracked_users", "ttft_ms_p50", "ttft_ms_p95",
		"ttft_ms_p99", "ttft_samples",
	}
	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != strings.Join(expected, ",") {
		t.Fatalf("runtime metrics shape changed:\n got %v\nwant %v", keys, expected)
	}
}

func TestRuntimeMetricsRouteReportsDegradedInsteadOfZeroedValues(t *testing.T) {
	modelClient := &fakeModelClient{runtimeMetricsErr: errors.New("scrape failed")}
	server := NewServer(testConfig(), modelClient)
	req := httptest.NewRequest(http.MethodGet, "/api/runtime/metrics", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("got status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["runtime_state"] != "degraded" {
		t.Fatalf("expected a degraded runtime state, got %#v", body["runtime_state"])
	}
	for _, absent := range []string{"prefix_cache_hit_rate", "runtime_queue_depth"} {
		if _, exists := body[absent]; exists {
			t.Fatalf("degraded metrics must omit %q rather than report zero: %#v", absent, body)
		}
	}
	if body["admission_enabled"] != true {
		t.Fatalf("admission counters must stay truthful when the scrape fails: %#v", body)
	}
}
