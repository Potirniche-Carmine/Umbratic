package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"umbratic-veil/internal/policy"
)

func (s *Server) handleRuntimeMetrics(w http.ResponseWriter, r *http.Request) {
	payload := s.runtimeMetrics(r.Context())
	if strings.Contains(r.URL.Query().Get("format"), "prometheus") {
		writePrometheus(w, payload)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// writePrometheus renders the same counters as OpenMetrics text. Veil keeps no
// dependencies, and the exposition format is simple enough that a client
// library would buy nothing: every value here is already a plain number.
// Non-numeric values — runtime_state is the only one — become a labelled gauge,
// because a scraper cannot alert on a string.
func writePrometheus(w http.ResponseWriter, payload map[string]any) {
	names := make([]string, 0, len(payload))
	for name := range payload {
		names = append(names, name)
	}
	sort.Strings(names)
	var body strings.Builder
	for _, name := range names {
		metric := "veil_" + name
		switch value := payload[name].(type) {
		case string:
			fmt.Fprintf(&body, "%s{state=%q} 1\n", metric, value)
		case bool:
			state := 0
			if value {
				state = 1
			}
			fmt.Fprintf(&body, "%s %d\n", metric, state)
		case int:
			fmt.Fprintf(&body, "%s %d\n", metric, value)
		case int64:
			fmt.Fprintf(&body, "%s %d\n", metric, value)
		case uint64:
			fmt.Fprintf(&body, "%s %d\n", metric, value)
		case float64:
			fmt.Fprintf(&body, "%s %g\n", metric, value)
		}
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body.String()))
}

func (s *Server) runtimeMetrics(parent context.Context) map[string]any {
	ctx, cancel := context.WithTimeout(parent, s.cfg.RequestTimeout)
	defer cancel()
	runtime, err := s.model.RuntimeMetrics(ctx)
	ops := s.admission.snapshot()
	// Admission counters are always truthful — they come from this process. Runtime
	// values come from a scrape that can fail, so a failure is reported as an
	// explicit degraded state instead of zeros that read as real measurements.
	payload := map[string]any{
		"active_requests":     ops.ActiveRequests,
		"queue_depth":         ops.QueueDepth,
		"queue_wait_ms_avg":   ops.QueueWaitMsAvg,
		"overload_count":      ops.OverloadCount,
		"cancel_count":        ops.CancelCount,
		"timeout_count":       ops.TimeoutCount,
		"release_error_count": ops.ReleaseErrorCount,
		"tracked_users":       ops.TrackedUsers,
		"global_limit":        ops.GlobalLimit,
		"per_user_limit":      ops.PerUserLimit,
		"queue_timeout_ms":    ops.QueueTimeoutMs,
		"admission_enabled":   ops.AdmissionEnabled,
	}
	for name, value := range s.stream.snapshot() {
		payload[name] = value
	}
	for name, value := range policy.CompatibilityCounters() {
		payload[name] = value
	}
	for name, value := range s.retriever.Counters() {
		payload[name] = value
	}
	switch {
	case err != nil:
		payload["runtime_state"] = "degraded"
	case runtime.Available:
		payload["runtime_state"] = "ready"
		payload["prefix_cache_hit_rate"] = runtime.PrefixCacheHitRate
		payload["runtime_queue_depth"] = runtime.QueueDepth
	default:
		payload["runtime_state"] = "unavailable"
	}
	return payload
}
