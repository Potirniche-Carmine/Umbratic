package httpapi

import (
	"context"
	"errors"
	"net/http"

	"umbratic-veil/internal/model"
	"umbratic-veil/internal/policy"
	"umbratic-veil/internal/prompts"
)

// orientMaxOutputTokens bounds the classifier reply. The decision is one small
// JSON object, but the budget must fit a two-sentence status (up to 240
// characters), the JSON scaffolding, and a stray reasoning preamble from a
// local model that ignores the no-reasoning request. 96 proved too tight in a
// live run — the reply truncated mid-object and orient degraded. Validation,
// not this cap, is what rejects non-decisions.
const orientMaxOutputTokens = 256

// handleOrient classifies one request into a hidden intent bucket.
//
// It is modeled on the compaction handler: non-streaming, server-prompted, one
// upstream call, free-form output parsed and validated server-side. It is
// deliberately deterministic — temperature 0, no tools, no thinking — because
// the only useful output is a closed enum plus one sentence.
func (s *Server) handleOrient(w http.ResponseWriter, r *http.Request) {
	input, err := policy.DecodeOrientInput(http.MaxBytesReader(w, r.Body, policy.MaxOrientRequestBytes+1024))
	if err != nil {
		if errors.Is(err, policy.ErrRequestTooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "orient request too large", "code": "orient_input_overflow"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error(), "code": "invalid_orient_request"})
		return
	}
	messages, err := prompts.BuildOrient(input.Route, input.RequestText, input.PreviousBucket)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "unknown route")
		return
	}
	req := model.ChatRequest{
		Model:           s.cfg.DefaultModel,
		Messages:        messages,
		Stream:          false,
		MaxOutputTokens: orientMaxOutputTokens,
		Temperature:     0,
		TopP:            1,
		ReasoningEffort: model.ReasoningNone,
		ParallelTools:   false,
	}
	if _, ok := finalRequestFits(req, s.cfg.ContextLength); !ok {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "orient input exceeds context", "code": "orient_input_overflow"})
		return
	}
	// Orient takes its own admission lease. Holding one lease across orient and
	// the following chat would double lease hold time under load.
	lease, ok := s.admitModelWork(w, r)
	if !ok {
		return
	}
	defer lease.release()
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
	defer cancel()
	response, err := s.model.Chat(ctx, req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			s.admission.recordCancel()
		}
		failure := classifyModelFailure(err, 0)
		s.noteModelFailure(failure)
		writeModelFailure(w, failure)
		return
	}
	raw, _ := response.Message.Content.(string)
	decision, err := prompts.ParseOrientDecision(input.Route, raw)
	if err != nil {
		// The reason is a static classification of the failure, never model
		// output. It travels to the runner's degraded diagnostic so "why did
		// orient degrade?" is answerable from the log.
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error":  "model returned an invalid orient decision",
			"code":   "invalid_orient_decision",
			"reason": prompts.OrientFailureReason(err),
		})
		return
	}
	// summarySentence is explicitly null for direct_answer.
	var sentence any
	if decision.SummarySentence != "" {
		sentence = decision.SummarySentence
	}
	writeJSON(w, http.StatusOK, map[string]any{"bucket": decision.Bucket, "summarySentence": sentence})
}
