package httpapi

import (
	"context"
	"net/http"

	"umbratic-veil/internal/policy"
	"umbratic-veil/internal/telemetry"
)

func (s *Server) handleRuntimeMetrics(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
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
	for name, value := range telemetry.DropCounters() {
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
	writeJSON(w, http.StatusOK, payload)
}
