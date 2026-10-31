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

// Orient is a classifier, not a generation. Thinking is forced off and the
// output is capped: earlier caps (96, then 256) were blown because thinking
// stayed on and ate the budget, returning empty content. With thinking off,
// the schema-constrained JSON decision fits in a small bound.
const orientMaxOutputTokens = 512

// handleOrient classifies one request into a hidden intent bucket.
//
// It is modeled on the compaction handler: non-streaming, server-prompted, one
// upstream call, free-form output parsed and validated server-side. It is
// deliberately deterministic — temperature 0, no tools, thinking off — because
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
	thinkingOff := false
	req := model.ChatRequest{
		Model:           s.cfg.DefaultModel,
		Messages:        messages,
		Stream:          false,
		Temperature:     0,
		TopP:            1,
		MaxOutputTokens: orientMaxOutputTokens,
		ReasoningEffort: model.ReasoningNone,
		Thinking:        &thinkingOff,
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
		"reason": "sentence failed validation: needs one line, at most 240 runes, and no bucket id",
	}
	if encoded, err := json.Marshal(record); err == nil {
		log.Printf("VEIL_DIAGNOSTIC %s", strings.ReplaceAll(strings.ReplaceAll(string(encoded), "\r", "\\r"), "\n", "\\n"))
	}
}

// recordOrientInvalidOutput records shape and size, never model output.
func recordOrientInvalidOutput(route prompts.Route, reason string, raw string) {
	record := map[string]any{
		"level":    "warn",
		"event":    "orient.invalid_output",
		"route":    string(route),
		"reason":   reason,
		"rawChars": len([]rune(raw)),
	}
	if encoded, err := json.Marshal(record); err == nil {
		log.Printf("VEIL_DIAGNOSTIC %s", strings.ReplaceAll(strings.ReplaceAll(string(encoded), "\r", "\\r"), "\n", "\\n"))
	}
}
