package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"umbratic-veil/internal/model"
	"umbratic-veil/internal/policy"
	"umbratic-veil/internal/prompts"
)

func validCompactionSummary(summary string) bool {
	headings := []string{
		"Goal and current request",
		"Constraints and decisions",
		"Work completed",
		"Files and verification",
		"Errors or blockers",
		"Next work",
	}
	cursor := 0
	for _, heading := range headings {
		position := strings.Index(summary[cursor:], heading)
		if position < 0 {
			return false
		}
		cursor += position + len(heading)
	}
	return true
}

func (s *Server) handleContextCompact(w http.ResponseWriter, r *http.Request) {
	const limit = 8 << 20
	input, err := policy.DecodeCompactionInput(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		if errors.Is(err, policy.ErrRequestTooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "compaction request too large", "code": "compaction_input_overflow"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error(), "code": "invalid_compaction_request"})
		return
	}
	source, err := json.Marshal(input.Messages)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid compaction messages", "code": "invalid_compaction_request"})
		return
	}
	profile := s.activeGenerationProfile()
	req := model.ChatRequest{
		Model:               s.cfg.DefaultModel,
		Messages:            prompts.BuildCompaction(input.PreviousSummary, string(source)),
		Stream:              false,
		MaxOutputTokens:     input.MaxSummaryTokens,
		Temperature:         profile.Temperature,
		TopP:                profile.TopP,
		ReasoningEffort:     profile.ReasoningEffort,
		ThinkingTokenBudget: profile.ThinkingTokenBudget,
		ParallelTools:       profile.ParallelToolCalls,
	}
	if _, ok := finalRequestFits(req, s.cfg.ContextLength); !ok {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "compaction input exceeds context", "code": "compaction_input_overflow"})
		return
	}
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
	summary, ok := response.Message.Content.(string)
	summary = strings.TrimSpace(summary)
	if !ok || len(summary) < 200 || len(summary) > 24_000 || len(summary) >= len(source)+len(input.PreviousSummary) || !validCompactionSummary(summary) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "model returned an invalid compaction summary", "code": "invalid_compaction_summary"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"summary": summary, "sourceDigest": input.SourceDigest})
}
