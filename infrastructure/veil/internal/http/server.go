package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"umbratic-veil/internal/config"
	"umbratic-veil/internal/model"
	"umbratic-veil/internal/policy"
	"umbratic-veil/internal/prompts"
	"umbratic-veil/internal/telemetry"
	"umbratic-veil/internal/templates"
)

type ModelClient interface {
	Chat(context.Context, model.ChatRequest) (model.ChatResponse, error)
	DoChat(context.Context, model.ChatRequest) (*http.Response, error)
	ListModels(context.Context) ([]model.ModelInfo, error)
	ActivateModel(context.Context, string) error
	ContextLength(context.Context, string) (int, error)
}

type Server struct {
	cfg          config.Config
	model        ModelClient
	templateErr  error
	templateData templates.Registry
}

const actionRequiredHeader = "X-Umbratic-Action-Required"

func NewServer(cfg config.Config, modelClient ModelClient) http.Handler {
	registry, err := templates.LoadFile(cfg.TemplateRegistryPath)
	return &Server{cfg: cfg, model: modelClient, templateData: registry, templateErr: err}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}
	if !s.authorized(r.Header.Get("Authorization")) {
		writeJSONError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	if r.URL.Path == "/api/health" {
		if r.Method != http.MethodGet {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleHealth(w, r)
		return
	}
	if r.URL.Path == "/api/model/context" {
		if r.Method != http.MethodGet {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleModelContext(w, r)
		return
	}

	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	switch r.URL.Path {
	case "/api/model/connect":
		s.handleModelConnect(w, r)
	case "/api/engineering/chat":
		s.handleChat(prompts.EngineeringChat)(w, r)
	case "/api/marketing/chat":
		s.handleChat(prompts.MarketingChat)(w, r)
	case "/api/sales/chat":
		s.handleChat(prompts.SalesChat)(w, r)
	case "/api/internal/context/compact":
		s.handleContextCompact(w, r)
	case "/api/telemetry":
		s.handleTelemetry(w, r)
	default:
		writeJSONError(w, http.StatusNotFound, "unknown route")
	}
}

func (s *Server) handleModelConnect(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
	defer cancel()

	available, err := s.configuredModelAvailable(ctx)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "model connection failed")
		return
	}
	if !available {
		writeJSONError(w, http.StatusServiceUnavailable, "configured model unavailable")
		return
	}
	if err := s.model.ActivateModel(ctx, s.cfg.DefaultModel); err != nil {
		writeJSONError(w, http.StatusBadGateway, "model connection failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "connected"})
}

func (s *Server) handleModelContext(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
	defer cancel()

	contextLength, err := s.model.ContextLength(ctx, s.cfg.DefaultModel)
	if err != nil && s.cfg.ContextLength <= 0 {
		writeJSONError(w, http.StatusBadGateway, "model context unavailable")
		return
	}
	if s.cfg.ContextLength > 0 && (contextLength <= 0 || s.cfg.ContextLength < contextLength) {
		contextLength = s.cfg.ContextLength
	}
	if contextLength <= 0 {
		writeJSONError(w, http.StatusBadGateway, "model context unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{
		"context_length":    contextLength,
		"max_output_tokens": s.cfg.MaxOutputTokens,
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
	defer cancel()

	available, err := s.configuredModelAvailable(ctx)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "health check failed")
		return
	}
	if !available {
		writeJSONError(w, http.StatusServiceUnavailable, "configured model unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleChat(route prompts.Route) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		input, err := policy.DecodeChatInput(http.MaxBytesReader(w, r.Body, s.cfg.MaxBodyBytes))
		if err != nil {
			if errors.Is(err, policy.ErrRequestTooLarge) {
				writeJSONError(w, http.StatusRequestEntityTooLarge, "request too large")
				return
			}
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		if requirement := policy.WorkspaceActionRequirement(input.Messages); requirement != policy.ActionNone {
			w.Header().Set(actionRequiredHeader, requirement)
		}
		if s.templateErr != nil {
			writeJSONError(w, http.StatusInternalServerError, "template registry unavailable")
			return
		}

		templateMessages := s.templateData.ProtectedContext(string(route), input.Messages)
		messages, err := prompts.BuildWithProtectedMessages(route, input.Messages, templateMessages, input.Skills)
		if err != nil {
			writeJSONError(w, http.StatusNotFound, "unknown route")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
		defer cancel()

		req := model.ChatRequest{
			Model:           s.cfg.DefaultModel,
			Messages:        messages,
			Stream:          input.Stream,
			Tools:           input.Tools,
			ToolChoice:      input.ToolChoice,
			MaxOutputTokens: effectiveMaxOutputTokens(input.MaxOutputTokens, s.cfg.MaxOutputTokens),
		}
		if estimated, ok := finalRequestFits(req, s.cfg.ContextLength); !ok {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
				"error":           "assembled request exceeds the configured context window",
				"code":            "context_overflow_preflight",
				"estimatedTokens": estimated,
				"contextLength":   s.cfg.ContextLength,
			})
			return
		}
		if input.Stream {
			s.streamChat(w, ctx, route, req)
			return
		}

		startedAt := time.Now()
		resp, err := s.model.Chat(ctx, req)
		if err != nil {
			failure := classifyModelFailure(err, 0)
			recordModelFailure(route, "request", failure, req, time.Since(startedAt))
			writeModelFailure(w, failure)
			return
		}

		writeJSON(w, http.StatusOK, map[string]model.Message{
			"message": resp.Message,
		})
	}
}

func estimatedValueTokens(value any) int {
	encoded, err := json.Marshal(value)
	if err != nil {
		return 1 << 30
	}
	return (len(encoded) + 2) / 3
}

func finalRequestFits(req model.ChatRequest, contextLength int) (int, bool) {
	if contextLength <= 0 {
		return 0, true
	}
	estimated := len(req.Messages)*10 + estimatedValueTokens(req.Messages) + estimatedValueTokens(req.Tools) + req.MaxOutputTokens
	return estimated, estimated <= contextLength
}

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
	req := model.ChatRequest{
		Model:           s.cfg.DefaultModel,
		Messages:        prompts.BuildCompaction(input.PreviousSummary, string(source)),
		Stream:          false,
		MaxOutputTokens: input.MaxSummaryTokens,
	}
	if _, ok := finalRequestFits(req, s.cfg.ContextLength); !ok {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "compaction input exceeds context", "code": "compaction_input_overflow"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
	defer cancel()
	response, err := s.model.Chat(ctx, req)
	if err != nil {
		failure := classifyModelFailure(err, 0)
		writeModelFailure(w, failure)
		return
	}
	summary, ok := response.Message.Content.(string)
	summary = strings.TrimSpace(summary)
	if !ok || len(summary) < 200 || len(summary) > 24_000 || len(summary) >= len(source)+len(input.PreviousSummary) || !validCompactionSummary(summary) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "model returned an invalid compaction summary", "code": "invalid_compaction_summary"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": 1, "summary": summary, "sourceDigest": input.SourceDigest})
}

func effectiveMaxOutputTokens(requested int, configured int) int {
	if requested > 0 && requested < configured {
		return requested
	}
	return configured
}

func (s *Server) handleTelemetry(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.TelemetryEnabled {
		writeJSONError(w, http.StatusForbidden, "telemetry disabled by admin policy")
		return
	}
	maxBodyBytes := s.cfg.TelemetryMaxBodyBytes
	if maxBodyBytes <= 0 {
		maxBodyBytes = s.cfg.MaxBodyBytes
	}
	bundle, raw, err := telemetry.DecodeBundle(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		if errors.Is(err, telemetry.ErrInvalidBundle) {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSONError(w, http.StatusBadRequest, "invalid telemetry request")
		return
	}
	storedPath, err := telemetry.StoreBundle(s.cfg.TelemetryStorePath, raw, time.Now(), s.cfg.TelemetryRetentionDays)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "telemetry storage unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"acceptedTasks":  len(bundle.Tasks),
		"acceptedEvents": len(bundle.ProductEvents),
		"retentionDays":  s.cfg.TelemetryRetentionDays,
		"stored":         storedPath != "",
	})
}

func (s *Server) configuredModelAvailable(ctx context.Context) (bool, error) {
	models, err := s.model.ListModels(ctx)
	if err != nil {
		return false, err
	}
	for _, available := range models {
		if available.ID == s.cfg.DefaultModel {
			return true, nil
		}
	}
	return false, nil
}

type modelFailure struct {
	Status         int
	Code           string
	Message        string
	UpstreamStatus int
}

func classifyModelFailure(err error, upstreamStatus int) modelFailure {
	if upstreamStatus > 0 {
		if upstreamStatus == http.StatusRequestEntityTooLarge {
			return modelFailure{Status: http.StatusRequestEntityTooLarge, Code: "context_overflow_upstream", Message: "model service rejected the assembled context", UpstreamStatus: upstreamStatus}
		}
		return modelFailure{
			Status:         http.StatusBadGateway,
			Code:           "model_service_rejected",
			Message:        "model service rejected the request",
			UpstreamStatus: upstreamStatus,
		}
	}
	var providerError model.ProviderError
	if errors.As(err, &providerError) {
		if providerError.StatusCode > 0 {
			return classifyModelFailure(nil, providerError.StatusCode)
		}
		switch providerError.Kind {
		case model.ProviderFailureTimeout:
			return modelFailure{Status: http.StatusGatewayTimeout, Code: "model_service_timeout", Message: "model service timed out"}
		case model.ProviderFailureInvalidResponse:
			return modelFailure{Status: http.StatusBadGateway, Code: "model_service_invalid_response", Message: "model service returned an invalid response"}
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return modelFailure{Status: http.StatusGatewayTimeout, Code: "model_service_timeout", Message: "model service timed out"}
	}
	return modelFailure{Status: http.StatusBadGateway, Code: "model_service_unavailable", Message: "model service could not be reached"}
}

func recordModelFailure(route prompts.Route, phase string, failure modelFailure, req model.ChatRequest, duration time.Duration) {
	requestBytes := 0
	if encoded, err := json.Marshal(map[string]any{"messages": req.Messages, "tools": req.Tools}); err == nil {
		requestBytes = len(encoded)
	}
	record := map[string]any{
		"level":           "error",
		"event":           "model.request_failed",
		"route":           string(route),
		"phase":           phase,
		"failureCode":     failure.Code,
		"messageCount":    len(req.Messages),
		"requestBytes":    requestBytes,
		"maxOutputTokens": req.MaxOutputTokens,
		"stream":          req.Stream,
		"durationMs":      duration.Milliseconds(),
	}
	if failure.UpstreamStatus > 0 {
		record["upstreamStatus"] = failure.UpstreamStatus
	}
	if encoded, err := json.Marshal(record); err == nil {
		log.Printf("VEIL_DIAGNOSTIC %s", encoded)
	}
}

func writeModelFailure(w http.ResponseWriter, failure modelFailure) {
	payload := map[string]any{"error": failure.Message, "code": failure.Code}
	if failure.UpstreamStatus > 0 {
		payload["upstreamStatus"] = failure.UpstreamStatus
	}
	writeJSON(w, failure.Status, payload)
}

func (s *Server) streamChat(w http.ResponseWriter, ctx context.Context, route prompts.Route, req model.ChatRequest) {
	startedAt := time.Now()
	resp, err := s.model.DoChat(ctx, req)
	if err != nil {
		failure := classifyModelFailure(err, 0)
		recordModelFailure(route, "request", failure, req, time.Since(startedAt))
		writeModelFailure(w, failure)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		failure := classifyModelFailure(nil, resp.StatusCode)
		recordModelFailure(route, "response_status", failure, req, time.Since(startedAt))
		writeModelFailure(w, failure)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	if err := model.WriteOpenAIChatSSE(s.cfg.ProviderProtocol, w, resp.Body); err != nil {
		failure := modelFailure{Status: http.StatusBadGateway, Code: "model_service_stream_incomplete", Message: "model service stream ended unexpectedly"}
		recordModelFailure(route, "response_stream", failure, req, time.Since(startedAt))
		encoded, _ := json.Marshal(map[string]string{"error": failure.Message, "code": failure.Code})
		_, _ = io.WriteString(w, "event: error\ndata: "+string(encoded)+"\n\n")
	}
}

func (s *Server) authorized(header string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	if token == "" || s.cfg.AuthToken == "" {
		return false
	}
	if len(token) != len(s.cfg.AuthToken) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.AuthToken)) == 1
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
