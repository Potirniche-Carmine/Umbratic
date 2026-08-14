package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"umbratic-veil/internal/config"
	"umbratic-veil/internal/entitlement"
	"umbratic-veil/internal/identity"
	"umbratic-veil/internal/model"
	"umbratic-veil/internal/prompts"
	"umbratic-veil/internal/rag"
	"umbratic-veil/internal/telemetry"
	"umbratic-veil/internal/templates"
)

type ModelClient interface {
	Chat(context.Context, model.ChatRequest) (model.ChatResponse, error)
	DoChat(context.Context, model.ChatRequest) (*http.Response, error)
	ListModels(context.Context) ([]model.ModelInfo, error)
	ActivateModel(context.Context, string) error
	ContextLength(context.Context, string) (int, error)
	RuntimeMetrics(context.Context) (model.RuntimeMetrics, error)
	PrefixTokens(ctx context.Context, key, modelID string, messages []model.Message) model.UsageAnnotation
	Embed(ctx context.Context, text string) ([]float32, error)
	// Available reports whether the runtime behind this model id lists it right
	// now. ListModels answers for the default runtime only; with a registry
	// each id may live behind its own process.
	Available(ctx context.Context, modelID string) (bool, error)
	// ThinkingSupported reports whether a thinking directive means anything for
	// this model, so the toggle can be disabled rather than silently ignored.
	ThinkingSupported(ctx context.Context, modelID string) bool
}

type Server struct {
	cfg          config.Config
	model        ModelClient
	identity     *identity.Store
	identityErr  error
	identityRate *identityRateLimiter
	admission    *admissionController
	lifecycle    *lifecycle
	stream       *streamMetrics
	templateErr  error
	templateData templates.Registry
	retriever    *rag.Retriever
	availability availabilityCache
	// speech is nil unless a transcription runtime is configured, which is what
	// keeps /api/transcribe absent rather than broken on a deployment without
	// one.
	speech *model.SpeechClient
}

type contextKey int

const (
	admissionUserKey contextKey = 1
)

// NewServer returns the API handler. It is a concrete type so the process can
// drive readiness and draining around it.
func NewServer(cfg config.Config, modelClient ModelClient) *Server {
	registry, err := templates.LoadFile(cfg.TemplateRegistryPath)
	profile := cfg.Generation
	if cfg.Mode == model.ModeLocal {
		profile = model.LocalGenerationProfile(cfg.MaxOutputTokens)
	}
	server := &Server{
		cfg: cfg, model: modelClient, templateData: registry, templateErr: err,
		identityRate: &identityRateLimiter{entries: map[string]rateEntry{}},
		lifecycle:    &lifecycle{},
		stream:       newStreamMetrics(),
		admission: newAdmissionController(
			profile.MaxConcurrentRequests,
			profile.MaxConcurrentRequestsUser,
			profile.QueueTimeout,
		),
		retriever: rag.New(cfg.RAG, modelClient),
	}
	if cfg.SpeechEnabled() {
		server.speech = model.NewSpeechClient(cfg.SpeechBaseURL, cfg.SpeechModel, cfg.SpeechAPIKey, cfg.ModelTimeout)
	}
	if cfg.CompanyIdentityMode {
		license, licenseErr := entitlement.Load(cfg.EntitlementPath)
		if licenseErr != nil {
			server.identityErr = licenseErr
		} else {
			server.identity, server.identityErr = identity.Open(cfg.IdentityStorePath, license)
		}
	}
	return server
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		writeJSONError(w, http.StatusNotFound, "not found")
		return
	}

	if s.cfg.CompanyIdentityMode {
		if s.identity == nil {
			writeCodedError(w, http.StatusServiceUnavailable, "identity_unavailable", "Company access is unavailable.")
			return
		}
		if s.handleCompanyIdentityRoute(w, r) {
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/control/") {
			if !s.controlAuthorized(r.Header.Get("Authorization")) {
				writeCodedError(w, http.StatusUnauthorized, "control_unauthorized", "Unauthorized.")
				return
			}
			s.handleControlRoute(w, r)
			return
		}
		deviceUID, sessionErr := s.authenticateProduct(r.Header.Get("Authorization"))
		if (r.URL.Path == "/api/health" || r.URL.Path == "/api/runtime/metrics") && sessionErr != nil && s.controlAuthorized(r.Header.Get("Authorization")) {
			sessionErr = nil
		}
		if sessionErr != nil {
			writeIdentityError(w, sessionErr)
			return
		}
		if deviceUID != "" {
			if userUID, userErr := s.identity.UserUIDForDevice(deviceUID); userErr == nil && userUID != "" {
				r = r.WithContext(context.WithValue(r.Context(), admissionUserKey, userUID))
			}
		}
		if isActivityProductRoute(r.URL.Path) {
			if deviceUID == "" {
				writeCodedError(w, http.StatusUnauthorized, "session_invalid", "The session is invalid.")
				return
			}
			if err := s.identity.Touch(deviceUID); err != nil {
				writeCodedError(w, http.StatusServiceUnavailable, "activity_update_failed", "Company access is unavailable.")
				return
			}
		}
	} else if !s.authorized(r.Header.Get("Authorization")) {
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
	if r.URL.Path == "/api/models" {
		if r.Method != http.MethodGet {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleModels(w, r)
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
	if r.URL.Path == "/api/runtime/metrics" {
		if r.Method != http.MethodGet {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleRuntimeMetrics(w, r)
		return
	}

	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// Model work is refused while starting or draining; telemetry and control
	// routes stay available so a restart is still observable.
	switch r.URL.Path {
	case "/api/engineering/chat", "/api/marketing/chat", "/api/sales/chat",
		"/api/internal/context/compact", "/api/internal/orient", "/api/transcribe":
		if !s.guardLifecycle(w) {
			return
		}
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
	case "/api/internal/orient":
		s.handleOrient(w, r)
	case "/api/transcribe":
		s.handleTranscribe(w, r)
	case "/api/telemetry":
		s.handleTelemetry(w, r)
	default:
		writeJSONError(w, http.StatusNotFound, "unknown route")
	}
}

func (s *Server) admitModelWork(w http.ResponseWriter, r *http.Request) (*admissionLease, bool) {
	userKey, _ := r.Context().Value(admissionUserKey).(string)
	lease, err := s.admission.acquire(r.Context(), userKey)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			writeCodedError(w, http.StatusRequestTimeout, "request_canceled", "The request was canceled.")
			return nil, false
		}
		writeBusy(w, s.activeGenerationProfile().QueueTimeout)
		return nil, false
	}
	return lease, true
}

func (s *Server) noteModelFailure(failure modelFailure) {
	switch failure.Code {
	case "model_service_timeout":
		s.admission.recordTimeout()
	}
}

func (s *Server) handleCompanyIdentityRoute(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/enrollment/enroll":
		if r.Method != http.MethodPost {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return true
		}
		if !s.allowIdentityRequest(w, r, "enroll", 10) {
			return true
		}
		var input struct {
			EnrollmentCode string `json:"enrollment_code"`
			PublicKey      string `json:"public_key"`
			DeviceLabel    string `json:"device_label"`
		}
		if !decodeStrictJSON(w, r, 64<<10, &input) {
			return true
		}
		result, err := s.identity.Enroll(input.EnrollmentCode, input.PublicKey, input.DeviceLabel)
		if err != nil {
			writeIdentityError(w, err)
			return true
		}
		writeJSON(w, http.StatusCreated, result)
		return true
	case "/api/session/challenge":
		if r.Method != http.MethodPost {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return true
		}
		if !s.allowIdentityRequest(w, r, "challenge", 30) {
			return true
		}
		var input struct {
			DeviceUID string `json:"device_uid"`
		}
		if !decodeStrictJSON(w, r, 16<<10, &input) {
			return true
		}
		result, err := s.identity.NewChallenge(strings.TrimSpace(input.DeviceUID))
		if err != nil {
			writeIdentityError(w, err)
			return true
		}
		writeJSON(w, http.StatusCreated, result)
		return true
	case "/api/session":
		if r.Method != http.MethodPost {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return true
		}
		// Unauthenticated Ed25519 verification. Bounded like `challenge`.
		if !s.allowIdentityRequest(w, r, "session", 30) {
			return true
		}
		var input struct {
			ChallengeUID string `json:"challenge_uid"`
			Signature    string `json:"signature"`
		}
		if !decodeStrictJSON(w, r, 16<<10, &input) {
			return true
		}
		result, err := s.identity.NewSession(strings.TrimSpace(input.ChallengeUID), strings.TrimSpace(input.Signature))
		if err != nil {
			writeIdentityError(w, err)
			return true
		}
		writeJSON(w, http.StatusCreated, result)
		return true
	case "/api/session/logout":
		if r.Method != http.MethodPost {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return true
		}
		if !s.allowIdentityRequest(w, r, "logout", 30) {
			return true
		}
		token := bearerToken(r.Header.Get("Authorization"))
		if _, err := s.identity.Authenticate(token); err != nil {
			writeIdentityError(w, err)
			return true
		}
		if err := s.identity.Logout(token); err != nil {
			writeCodedError(w, http.StatusServiceUnavailable, "logout_failed", "Logout failed.")
			return true
		}
		w.WriteHeader(http.StatusNoContent)
		return true
	default:
		return false
	}
}

type rateEntry struct {
	window time.Time
	count  int
}

type identityRateLimiter struct {
	mu      sync.Mutex
	entries map[string]rateEntry
}

func (s *Server) allowIdentityRequest(w http.ResponseWriter, r *http.Request, action string, limit int) bool {
	key := s.identityRateKey(r, action)
	now := time.Now()
	s.identityRate.mu.Lock()
	entry := s.identityRate.entries[key]
	if !entry.window.IsZero() && now.Sub(entry.window) >= time.Minute {
		entry = rateEntry{}
	}
	if len(s.identityRate.entries) >= 4096 {
		for candidate, value := range s.identityRate.entries {
			if now.Sub(value.window) >= time.Minute {
				delete(s.identityRate.entries, candidate)
			}
		}
	}
	allowed := entry.count < limit
	if _, exists := s.identityRate.entries[key]; !exists && len(s.identityRate.entries) >= 4096 {
		allowed = false
	}
	if allowed {
		if entry.window.IsZero() {
			entry.window = now
		}
		entry.count++
		s.identityRate.entries[key] = entry
	}
	s.identityRate.mu.Unlock()
	if allowed {
		return true
	}
	w.Header().Set("Retry-After", "60")
	writeCodedError(w, http.StatusTooManyRequests, "rate_limited", "Try again later.")
	return false
}

// clientAddress returns the address the rate limiter should key on. The shipped
// deployment terminates TLS in Caddy and proxies to loopback, so RemoteAddr is
// the proxy for every request and would make each limit organization-wide
// rather than per client. X-Forwarded-For is believed only when the immediate
// peer is a configured trusted proxy, because any client can send that header.
func (s *Server) clientAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if len(s.cfg.TrustedProxyCIDRs) == 0 {
		return host
	}
	peer, err := netip.ParseAddr(strings.TrimSpace(host))
	if err != nil {
		return host
	}
	peer = peer.Unmap()
	trusted := false
	for _, prefix := range s.cfg.TrustedProxyCIDRs {
		if prefix.Contains(peer) {
			trusted = true
			break
		}
	}
	if !trusted {
		return host
	}
	// Caddy is configured to overwrite rather than append, so the right-most
	// entry is the closest untrusted hop.
	forwarded := r.Header.Values("X-Forwarded-For")
	for index := len(forwarded) - 1; index >= 0; index-- {
		hops := strings.Split(forwarded[index], ",")
		for hop := len(hops) - 1; hop >= 0; hop-- {
			candidate := strings.TrimSpace(hops[hop])
			if candidate == "" {
				continue
			}
			if address, parseErr := netip.ParseAddr(candidate); parseErr == nil {
				return address.Unmap().String()
			}
			if addressPort, parseErr := netip.ParseAddrPort(candidate); parseErr == nil {
				return addressPort.Addr().Unmap().String()
			}
		}
	}
	return host
}

func (s *Server) identityRateKey(r *http.Request, action string) string {
	return action + "|" + s.clientAddress(r)
}

func (s *Server) handleControlRoute(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/control/access" {
		if r.Method != http.MethodGet {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return
		}
		writeJSON(w, http.StatusOK, s.identity.Snapshot())
		return
	}
	if r.URL.Path == "/api/control/organization" {
		if r.Method != http.MethodPost {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return
		}
		var input struct {
			Name string `json:"name"`
		}
		if !decodeStrictJSON(w, r, 16<<10, &input) {
			return
		}
		writeControlMutation(w, s.identity.SetOrganizationName(input.Name))
		return
	}
	if r.URL.Path == "/api/control/users" {
		if r.Method != http.MethodPost {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return
		}
		var input struct {
			Label string `json:"label"`
		}
		if !decodeStrictJSON(w, r, 16<<10, &input) {
			return
		}
		user, err := s.identity.CreateUser(input.Label)
		if err != nil {
			writeIdentityError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, user)
		return
	}

	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/control/"), "/")
	if len(parts) == 3 && parts[0] == "users" {
		userUID, action := parts[1], parts[2]
		if r.Method != http.MethodPost {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return
		}
		switch action {
		case "deactivate":
			writeControlMutation(w, s.identity.DeactivateUser(userUID))
		case "reactivate":
			writeControlMutation(w, s.identity.ReactivateUser(userUID))
		case "enrollment-codes":
			result, err := s.identity.IssueEnrollmentCode(userUID)
			if err != nil {
				writeIdentityError(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, result)
		default:
			writeCodedError(w, http.StatusNotFound, "control_route_not_found", "Not found.")
		}
		return
	}
	if len(parts) == 3 && parts[0] == "enrollment-codes" && parts[2] == "revoke" {
		if r.Method != http.MethodPost {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return
		}
		writeControlMutation(w, s.identity.RevokeEnrollmentCode(parts[1]))
		return
	}
	if len(parts) == 3 && parts[0] == "devices" && parts[2] == "revoke" {
		if r.Method != http.MethodPost {
			writeCodedError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed.")
			return
		}
		writeControlMutation(w, s.identity.RevokeDevice(parts[1]))
		return
	}
	writeCodedError(w, http.StatusNotFound, "control_route_not_found", "Not found.")
}

func writeControlMutation(w http.ResponseWriter, err error) {
	if err != nil {
		writeIdentityError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func decodeStrictJSON(w http.ResponseWriter, r *http.Request, limit int64, output any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		writeCodedError(w, http.StatusBadRequest, "invalid_request", "Request body is invalid.")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeCodedError(w, http.StatusBadRequest, "invalid_request", "Request body is invalid.")
		return false
	}
	return true
}

func writeIdentityError(w http.ResponseWriter, err error) {
	var identityError *identity.Error
	if !errors.As(err, &identityError) {
		writeCodedError(w, http.StatusInternalServerError, "identity_error", "Company access failed.")
		return
	}
	status := http.StatusBadRequest
	switch identityError.Code {
	case "session_invalid", "session_expired", "device_not_authorized", "challenge_proof_invalid", "challenge_invalid", "enrollment_code_invalid", "enrollment_code_expired":
		status = http.StatusUnauthorized
	case "entitlement_over_limit":
		status = http.StatusForbidden
	case "seat_limit_reached", "device_limit_reached", "device_already_enrolled", "enrollment_code_not_pending", "user_deactivated":
		status = http.StatusConflict
	case "challenge_capacity", "session_capacity":
		status = http.StatusServiceUnavailable
	case "user_not_found", "device_not_found", "enrollment_code_not_found":
		status = http.StatusNotFound
	}
	writeCodedError(w, status, identityError.Code, identityError.Message)
}

func isActivityProductRoute(path string) bool {
	switch path {
	case "/api/model/connect", "/api/model/context", "/api/models", "/api/engineering/chat", "/api/marketing/chat",
		"/api/sales/chat", "/api/internal/context/compact", "/api/internal/orient", "/api/telemetry",
		"/api/transcribe":
		return true
	default:
		return false
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

	// The window belongs to the model, so a client that lets a user pick one
	// has to be able to ask about that one. An unknown id falls back to the
	// default rather than failing: the caller learns the truth from /api/models.
	selected := s.cfg.DefaultModel
	if requested := strings.TrimSpace(r.URL.Query().Get("model")); requested != "" {
		if _, ok := s.cfg.ModelEntryByID(requested); ok {
			selected = requested
		}
	}
	configured := s.contextLengthFor(selected)

	contextLength, err := s.model.ContextLength(ctx, selected)
	if err != nil && configured <= 0 {
		writeJSONError(w, http.StatusBadGateway, "model context unavailable")
		return
	}
	if configured > 0 && (contextLength <= 0 || configured < contextLength) {
		contextLength = configured
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
	// A successful health check is also the warm signal: the model answered.
	s.lifecycle.markReady()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "ok",
		"state":    string(s.lifecycle.state()),
		"features": Features(s.cfg.RAG.Enabled, s.cfg.ModelSelectionEnabled, s.cfg.SpeechEnabled()),
		"capabilities": map[string]bool{
			"parallel_tool_calls": s.cfg.ModelParallelToolCalls,
			"vision":              s.cfg.ModelVision,
			"reasoning":           s.defaultModelReasons(ctx),
		},
	})
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
	bundle, raw, drops, err := telemetry.DecodeBundle(http.MaxBytesReader(w, r.Body, maxBodyBytes))
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
		"droppedRecords": drops.Total(),
		"retentionDays":  s.cfg.TelemetryRetentionDays,
		"stored":         storedPath != "",
	})
}

// defaultModelReasons is what capabilities.reasoning has always meant — can the
// model this server answers with think — asked of the model rather than only of
// the environment, now that local runtimes can be asked directly.
func (s *Server) defaultModelReasons(ctx context.Context) bool {
	if s.cfg.Mode == model.ModeLocal {
		return s.model.ThinkingSupported(ctx, s.cfg.DefaultModel)
	}
	if entry, ok := s.cfg.ModelEntryByID(s.cfg.DefaultModel); ok && entry.Reasoning {
		return true
	}
	return s.cfg.ModelReasoning
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
	// Detail is Veil's own transport-level error text (a Go http client error,
	// never model output), bounded for local diagnostics. It is recorded in the
	// VEIL_DIAGNOSTIC event only and never sent to clients — "model service
	// could not be reached" alone proved undebuggable in a live run.
	Detail string
}

func classifyModelFailure(err error, upstreamStatus int) modelFailure {
	failure := classifyModelFailureKind(err, upstreamStatus)
	if err != nil {
		failure.Detail = boundedFailureDetail(err)
	}
	return failure
}

func boundedFailureDetail(err error) string {
	detail := strings.Join(strings.Fields(err.Error()), " ")
	if runes := []rune(detail); len(runes) > 300 {
		return string(runes[:300])
	}
	return detail
}

func classifyModelFailureKind(err error, upstreamStatus int) modelFailure {
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
	if failure.Detail != "" {
		record["detail"] = failure.Detail
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

func (s *Server) authorized(header string) bool {
	return tokenAuthorized(bearerToken(header), s.cfg.AuthToken)
}

func (s *Server) controlAuthorized(header string) bool {
	return tokenAuthorized(bearerToken(header), s.cfg.ControlToken)
}

func (s *Server) authenticateProduct(header string) (string, error) {
	token := bearerToken(header)
	if token == "" {
		return "", &identity.Error{Code: "session_invalid", Message: "The session is invalid."}
	}
	return s.identity.Authenticate(token)
}

func bearerToken(header string) string {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(header, prefix))
}

func tokenAuthorized(token, expected string) bool {
	if token == "" || expected == "" || len(token) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeCodedError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}
