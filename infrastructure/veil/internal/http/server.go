package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
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
	writeJSON(w, http.StatusOK, map[string]int{"context_length": contextLength})
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
			Model:      s.cfg.DefaultModel,
			Messages:   messages,
			Stream:     input.Stream,
			Tools:      input.Tools,
			ToolChoice: input.ToolChoice,
		}
		if input.Stream {
			s.streamChat(w, ctx, req)
			return
		}

		resp, err := s.model.Chat(ctx, req)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "model request failed")
			return
		}

		writeJSON(w, http.StatusOK, map[string]model.Message{
			"message": resp.Message,
		})
	}
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

func (s *Server) streamChat(w http.ResponseWriter, ctx context.Context, req model.ChatRequest) {
	resp, err := s.model.DoChat(ctx, req)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "model request failed")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		writeJSONError(w, http.StatusBadGateway, "model request failed")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	if err := model.WriteOpenAIChatSSE(s.cfg.ProviderProtocol, w, resp.Body); err != nil {
		_, _ = io.WriteString(w, "event: error\ndata: {\"error\":\"incomplete model stream\"}\n\n")
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
