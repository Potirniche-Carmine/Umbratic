package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"umbratic-veil/internal/model"
	"umbratic-veil/internal/policy"
	"umbratic-veil/internal/prompts"
)

// Orient sets no output cap and does not suppress thinking: the model decides
// how much to reason before answering. Every cap tried so far (96, then 256)
// was blown by a thinking-by-default model reasoning inside the budget and
// returning an empty content. The harness constrains the *shape* instead —
// the response schema means whatever content arrives can only be one decision
// object — and validation rejects anything else.

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
	messages, err := prompts.BuildOrient(input.Route, input.RequestText, input.PreviousResponse)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "unknown route")
		return
	}
	req := model.ChatRequest{
		Model:    s.cfg.DefaultModel,
		Messages: messages,
		Stream:   false,
		// ReasoningNone means "do not force an effort level", not "forbid
		// thinking": the local path leaves Ollama's thinking default alone and
		// the server path omits reasoning_effort entirely.
		Temperature:     0,
		TopP:            1,
		ReasoningEffort: model.ReasoningNone,
		ParallelTools:   false,
		ResponseSchema:  prompts.OrientResponseSchema(),
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
		reason := prompts.OrientFailureReason(err)
		recordOrientInvalidOutput(input.Route, reason, raw)
		// The reason is a static classification of the failure, never model
		// output. It travels to the runner's degraded diagnostic so "why did
		// orient degrade?" is answerable from the log.
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error":  "model returned an invalid orient decision",
			"code":   "invalid_orient_decision",
			"reason": reason,
		})
		return
	}
	// summarySentence is explicitly null for direct_answer and for a guided
	// sentence that failed validation. There is deliberately no canned
	// fallback: the opening status line is the assistant speaking, so it is
	// model-written or it is absent. Reliability comes from the response
	// grammar instead — the schema requires the sentence as a string, so the
	// model cannot decline to write one the way it could when null was an
	// allowed answer. A drop is rare and diagnosable below.
	var sentence any
	if decision.SummarySentence != "" {
		sentence = decision.SummarySentence
	}
	if decision.SentenceDropped {
		recordOrientSentenceDropped(input.Route, decision.Bucket)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"bucket":          decision.Bucket,
		"summarySentence": sentence,
		// The catalog's answer to "may this turn end without a tool call?".
		// Sent as a resolved boolean so the runner enforces the rule without
		// holding a copy of the bucket catalog.
		"evidenceRequired": prompts.RequiresEvidence(input.Route, decision.Bucket),
	})
}

// recordOrientSentenceDropped logs that a guided run lost its status line to
// validation rather than to an absent sentence. Without this the runner's
// sentence:"missing" diagnostic covers both causes and neither is actionable.
// The record carries no model output, only the static classification.
func recordOrientSentenceDropped(route prompts.Route, bucket string) {
	record := map[string]any{
		"level":  "warn",
		"event":  "orient.sentence_dropped",
		"route":  string(route),
		"bucket": bucket,
		"reason": "sentence failed validation: needs one line ending in . or !, at most 240 runes, and no bucket id",
	}
	if encoded, err := json.Marshal(record); err == nil {
		log.Printf("VEIL_DIAGNOSTIC %s", encoded)
	}
}

// recordOrientInvalidOutput logs a bounded sample of the unparseable classifier
// output to local diagnostics. Three live sessions degraded with the same
// static reason before the actual cause — thinking-by-default local models
// returning an empty content — could only be found by reproducing the request
// by hand. The sample is the operator's own model output about the user's own
// request, whitespace-collapsed and capped, and it never reaches a client
// response.
func recordOrientInvalidOutput(route prompts.Route, reason string, raw string) {
	sample := strings.Join(strings.Fields(raw), " ")
	if runes := []rune(sample); len(runes) > 160 {
		sample = string(runes[:160])
	}
	record := map[string]any{
		"level":    "warn",
		"event":    "orient.invalid_output",
		"route":    string(route),
		"reason":   reason,
		"rawChars": len([]rune(raw)),
		"sample":   sample,
	}
	if encoded, err := json.Marshal(record); err == nil {
		log.Printf("VEIL_DIAGNOSTIC %s", encoded)
	}
}
