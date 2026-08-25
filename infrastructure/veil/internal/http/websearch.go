package httpapi

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"umbratic-veil/internal/policy"
	"umbratic-veil/internal/websearch"
)

// webSearchTimeout bounds one outbound search, including the wait for its turn
// at the 1 QPS gate. Twenty seconds is what the tool allowed when it still ran
// on the desktop; the rest covers a request queued behind another user's.
const webSearchTimeout = 30 * time.Second

// handleWebSearch runs one public web search on behalf of the caller.
//
// The company's subscription lives here rather than on each desktop, so this
// route is where the two things that come with owning it are enforced: the
// month's purchased pool, and the outbound spacing the credit plan allows. The
// per-user request rate is handled upstream in ServeHTTP, on its own limiter.
func (s *Server) handleWebSearch(w http.ResponseWriter, r *http.Request) {
	// No key in this build, or an organization that bought no searches, are the
	// same answer to the client: this server does not do web search. The runner
	// must not fall back to a direct search of its own, so "absent" has to be
	// said plainly rather than as a failure it might retry around.
	limit := s.webSearchMonthlyLimit()
	if s.webSearch == nil || limit == 0 {
		writeCodedError(w, http.StatusNotFound, "web_search_unconfigured", "Web search is not configured on this server.")
		return
	}
	input, err := policy.DecodeWebSearchInput(http.MaxBytesReader(w, r.Body, policy.MaxWebSearchQueryBytes+4096))
	if err != nil {
		writeCodedError(w, http.StatusBadRequest, "invalid_request", "Request body is invalid.")
		return
	}

	allowed, err := s.webSearchUsage.Reserve(limit, time.Now())
	if err != nil {
		recordWebSearchFailure("usage", err)
		writeCodedError(w, http.StatusBadGateway, "web_search_unavailable", "Web search is unavailable right now.")
		return
	}
	if !allowed {
		writeCodedError(w, http.StatusTooManyRequests, "web_search_quota_exhausted", "This month's web search allowance is spent.")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), webSearchTimeout)
	defer cancel()
	results, err := s.webSearch.Search(ctx, input.Query)
	if err != nil {
		recordWebSearchFailure("upstream", err)
		writeCodedError(w, http.StatusBadGateway, "web_search_unavailable", "Web search is unavailable right now.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// webSearchMonthlyLimit is the organization's purchased pool for this month.
// Shared-token mode has no entitlement document to read one from, so it is
// unmetered: that mode is for development, and the per-user rate limit still
// bounds it.
func (s *Server) webSearchMonthlyLimit() int {
	if !s.cfg.CompanyIdentityMode {
		return websearch.Unmetered
	}
	return s.license.MaxSearchesPerMonth
}

// webSearchAvailable reports whether a search sent right now could actually be
// served: this build carries a subscription key, the ledger opened, and the
// month still has room. All of it matters, because the feature name is a
// promise — a search tool that fails on first use is worse than no search tool.
func (s *Server) webSearchAvailable() bool {
	return s.webSearch != nil && s.webSearchUsage.Available(s.webSearchMonthlyLimit(), time.Now())
}

// recordWebSearchFailure logs why a search did not happen. The detail is Veil's
// own error text and never the upstream body, the query, or the subscription
// token: the query is the user's words and the token is the company's
// credential, and an operator log is the wrong home for either.
func recordWebSearchFailure(stage string, err error) {
	record := map[string]any{
		"level":  "warn",
		"event":  "web_search.failed",
		"stage":  stage,
		"detail": boundedFailureDetail(err),
	}
	if encoded, marshalErr := json.Marshal(record); marshalErr == nil {
		log.Printf("VEIL_DIAGNOSTIC %s", encoded)
	}
}
