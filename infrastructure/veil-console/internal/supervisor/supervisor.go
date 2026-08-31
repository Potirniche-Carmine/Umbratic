package supervisor

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"umbratic-veil-console/internal/config"
)

var ErrBusy = errors.New("another Veil action is in progress")

const (
	// An unexpected exit is retried with a widening delay, and only while the
	// crashes stay inside restartWindow. Past maxRestartsInWindow the process is
	// left down: a Veil that dies on every start needs an administrator, and a
	// tight restart loop only buries the log line that explains why.
	restartWindow       = 5 * time.Minute
	maxRestartsInWindow = 3
	restartBackoffBase  = 2 * time.Second
	restartBackoffMax   = 60 * time.Second
)

type Status struct {
	Running bool
	Healthy bool
	PID     int
	Message string
}

// OpsMetrics is the administrator-safe Veil admission and runtime summary.
type OpsMetrics struct {
	Available      bool
	ActiveRequests int64
	QueueDepth     int64
	QueueWaitMsAvg float64
	OverloadCount  uint64
	CancelCount    uint64
	TimeoutCount   uint64
	ReleaseErrors  uint64
	TrackedUsers   int
	GlobalLimit    int
	PerUserLimit   int
	RuntimeState   string
	PrefixCacheHit float64
	RuntimeQueue   float64
}

type Supervisor struct {
	binary            string
	veilAddress       string
	actionMu          sync.Mutex
	stateMu           sync.RWMutex
	cmd               *exec.Cmd
	status            Status
	logs              *safeBuffer
	entitlementPath   string
	identityStorePath string
	internalToken     string
	rag               config.RAG
	ragAPIKey         string
	models            []config.ManagedModel
	// startedModels is what the live process was actually launched with, which
	// is a different question from what the next start will use.
	startedModels []config.ManagedModel
	// lastConfig and lastToken are what an automatic restart replays. They are
	// recorded on every successful start, so recovery uses the configuration
	// that was actually running rather than whatever the store now holds.
	lastConfig *config.Veil
	lastToken  string
	// stopping marks an operator-initiated stop so the exit is not mistaken for
	// a crash. crashes holds the recent unexpected exits inside restartWindow.
	stopping bool
	crashes  []time.Time
}

// SetRAG records the retrieval configuration handed to the next Veil start.
// Retrieval settings reach Veil the same way every other setting does — through
// the allowlisted child environment — so a change takes effect on restart and
// nothing is written to disk for Veil to read.
func (s *Supervisor) SetRAG(settings config.RAG, apiKey string) {
	s.stateMu.Lock()
	s.rag, s.ragAPIKey = settings, apiKey
	s.stateMu.Unlock()
}

// SetModels records the registry handed to the next Veil start. Like RAG, it
// reaches Veil only through the allowlisted child environment, so a change
// takes effect on restart and nothing is written to disk for Veil to read.
//
// Starting or stopping a model does NOT go through here: availability is live
// on Veil's /api/models, and only the registered set is configuration.
func (s *Supervisor) SetModels(models []config.ManagedModel) {
	s.stateMu.Lock()
	s.models = append([]config.ManagedModel(nil), models...)
	s.stateMu.Unlock()
}

// ModelsEnvironment is the VEIL_MODELS value the running Veil was started with,
// so the page can say when the stored set has drifted from it. Empty while Veil
// is stopped: there is then nothing for a change to be pending against.
func (s *Supervisor) ModelsEnvironment() string {
	s.stateMu.RLock()
	models := s.startedModels
	s.stateMu.RUnlock()
	return modelsEnvOrEmpty(models)
}

// PendingModelsEnvironment is what the next start will carry — the registry
// SetModels last recorded.
func (s *Supervisor) PendingModelsEnvironment() string {
	s.stateMu.RLock()
	models := s.models
	s.stateMu.RUnlock()
	return modelsEnvOrEmpty(models)
}

// SpeechEnvironment is the dictation configuration the running Veil was started
// with, and PendingSpeechEnvironment the one the next start will carry. They
// are tracked separately from the chat registry because a deployment can gain
// its first speech model without the chat registry changing at all, and that
// still needs a restart to take effect.
func (s *Supervisor) SpeechEnvironment() string {
	s.stateMu.RLock()
	models := s.startedModels
	s.stateMu.RUnlock()
	return strings.Join(config.SpeechEnvironment(models), "\n")
}

func (s *Supervisor) PendingSpeechEnvironment() string {
	s.stateMu.RLock()
	models := s.models
	s.stateMu.RUnlock()
	return strings.Join(config.SpeechEnvironment(models), "\n")
}

func modelsEnvOrEmpty(models []config.ManagedModel) string {
	value, err := config.ModelsEnvJSON(models)
	if err != nil {
		return ""
	}
	return value
}

func New(binary, veilAddress string) *Supervisor {
	return &Supervisor{binary: binary, veilAddress: veilAddress, logs: newSafeBuffer(32 << 10)}
}

func (s *Supervisor) EnableCompanyIdentity(entitlementPath, identityStorePath string) error {
	if strings.TrimSpace(entitlementPath) == "" || strings.TrimSpace(identityStorePath) == "" {
		return errors.New("company identity paths are required")
	}
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return err
	}
	s.entitlementPath = entitlementPath
	s.identityStorePath = identityStorePath
	s.internalToken = base64.RawURLEncoding.EncodeToString(value)
	return nil
}

func (s *Supervisor) Status() Status {
	s.stateMu.RLock()
	defer s.stateMu.RUnlock()
	return s.status
}

func (s *Supervisor) Logs() string { return s.logs.String() }

func (s *Supervisor) Start(ctx context.Context, cfg config.Veil, token string) error {
	if !s.actionMu.TryLock() {
		return ErrBusy
	}
	defer s.actionMu.Unlock()
	return s.startLocked(ctx, cfg, token)
}

func (s *Supervisor) startLocked(ctx context.Context, cfg config.Veil, token string) error {
	if cfg.Validate() != nil {
		return errors.New("Veil configuration is invalid")
	}
	s.stateMu.RLock()
	running := s.cmd != nil && s.cmd.Process != nil
	s.stateMu.RUnlock()
	if running {
		return errors.New("Veil is already running")
	}
	s.stateMu.RLock()
	rag, ragAPIKey, models := s.rag, s.ragAPIKey, s.models
	s.stateMu.RUnlock()
	s.logs.SetSecrets(token, s.internalToken, ragAPIKey)
	cmd := exec.Command(s.binary)
	configureProcess(cmd)
	healthToken := token
	if s.entitlementPath != "" {
		cmd.Env = cfg.CompanyEnvironment(s.veilAddress, s.internalToken, token, s.entitlementPath, s.identityStorePath)
	} else {
		cmd.Env = cfg.Environment(s.veilAddress, token)
	}
	cmd.Env = append(cmd.Env, rag.Environment(ragAPIKey)...)
	// An empty registry means no VEIL_MODELS at all, which is what keeps a
	// single-model deployment byte identical to one that predates this page.
	if entries, err := config.ModelsEnvJSON(models); err == nil && entries != "" {
		cmd.Env = append(cmd.Env, "VEIL_MODELS="+entries)
	}
	// No speech model means neither variable is set, and Veil refuses to start
	// on half a pair — so this is all or nothing by construction.
	cmd.Env = append(cmd.Env, config.SpeechEnvironment(models)...)
	cmd.Stdout, cmd.Stderr = s.logs, s.logs
	if err := cmd.Start(); err != nil {
		return errors.New("Veil did not start")
	}
	s.stateMu.Lock()
	s.cmd = cmd
	s.startedModels = models
	s.lastConfig, s.lastToken = &cfg, token
	s.status = Status{Running: true, PID: cmd.Process.Pid, Message: "Starting"}
	s.stateMu.Unlock()
	go s.wait(cmd)
	// The gate for a successful start is the process accepting connections, not
	// the model runtime answering: models are started and stopped while Veil
	// stays up, and availability is live on /api/models. Requiring /api/health
	// here meant Veil could never start before its default model was serving —
	// including the automatic start after every Console boot.
	healthCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := waitForLive(healthCtx, s.veilAddress); err != nil {
		_ = s.stopLocked(context.Background())
		return errors.New("Veil health check failed")
	}
	healthy := healthProbe(healthCtx, s.veilAddress, healthToken)
	s.stateMu.Lock()
	if s.cmd == cmd {
		if healthy {
			s.status.Healthy = true
			s.status.Message = "Healthy"
		} else {
			s.status.Message = "Running — model runtime unavailable"
		}
	}
	s.stateMu.Unlock()
	return nil
}

func (s *Supervisor) wait(cmd *exec.Cmd) {
	err := cmd.Wait()
	s.stateMu.Lock()
	if s.cmd != cmd {
		s.stateMu.Unlock()
		return
	}
	s.cmd = nil
	s.startedModels = nil
	s.status.Running = false
	s.status.Healthy = false
	s.status.PID = 0
	if err != nil {
		s.status.Message = "Veil exited unexpectedly"
	} else {
		s.status.Message = "Stopped"
	}
	recoverable := err != nil && !s.stopping && s.lastConfig != nil
	s.stateMu.Unlock()
	if recoverable {
		go s.recover()
	}
}

// recover brings Veil back after an unexpected exit. It handles one exit: a
// crash after a successful restart arrives here again through wait, which is
// what makes the crash window meaningful rather than a retry counter.
func (s *Supervisor) recover() {
	s.stateMu.Lock()
	now := time.Now()
	live := s.crashes[:0]
	for _, at := range s.crashes {
		if now.Sub(at) < restartWindow {
			live = append(live, at)
		}
	}
	s.crashes = append(live, now)
	attempts := len(s.crashes)
	cfg, token := *s.lastConfig, s.lastToken
	s.stateMu.Unlock()

	if attempts > maxRestartsInWindow {
		s.note("Veil keeps exiting. Automatic restart is paused — check the log, then start it from this page.")
		return
	}
	delay := restartBackoffBase * time.Duration(1<<(attempts-1))
	if delay > restartBackoffMax {
		delay = restartBackoffMax
	}
	s.note(fmt.Sprintf("Veil exited unexpectedly. Restarting in %s.", delay.Round(time.Second)))
	timer := time.NewTimer(delay)
	defer timer.Stop()
	<-timer.C

	if !s.actionMu.TryLock() {
		return
	}
	defer s.actionMu.Unlock()
	s.stateMu.RLock()
	running := s.cmd != nil
	s.stateMu.RUnlock()
	if running {
		return
	}
	if err := s.startLocked(context.Background(), cfg, token); err != nil {
		s.note("Veil exited unexpectedly and did not restart.")
	}
}

func (s *Supervisor) note(message string) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.cmd == nil {
		s.status.Message = message
	}
}

func (s *Supervisor) Stop(ctx context.Context) error {
	if !s.actionMu.TryLock() {
		return ErrBusy
	}
	defer s.actionMu.Unlock()
	return s.stopLocked(ctx)
}

func (s *Supervisor) stopLocked(ctx context.Context) error {
	s.stateMu.RLock()
	cmd := s.cmd
	s.stateMu.RUnlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	s.setStopping(true)
	defer s.setStopping(false)
	requestProcessStop(cmd)
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		s.stateMu.RLock()
		running := s.cmd == cmd
		s.stateMu.RUnlock()
		if !running {
			return nil
		}
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return ctx.Err()
		case <-deadline.C:
			_ = cmd.Process.Kill()
			return nil
		case <-ticker.C:
		}
	}
}

func (s *Supervisor) setStopping(stopping bool) {
	s.stateMu.Lock()
	s.stopping = stopping
	s.stateMu.Unlock()
}

func (s *Supervisor) Restart(ctx context.Context, cfg config.Veil, token string) error {
	if !s.actionMu.TryLock() {
		return ErrBusy
	}
	defer s.actionMu.Unlock()
	return s.restartLocked(ctx, cfg, token)
}

func (s *Supervisor) restartLocked(ctx context.Context, cfg config.Veil, token string) error {
	if err := s.stopLocked(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return s.startLocked(ctx, cfg, token)
}

// RunExclusive serializes apply, rotate, start, stop, and restart callers that need
// store + process mutations under one critical section.
func (s *Supervisor) RunExclusive(fn func() error) error {
	if !s.actionMu.TryLock() {
		return ErrBusy
	}
	defer s.actionMu.Unlock()
	return fn()
}

// RestartExclusive restarts Veil while already holding actionMu via RunExclusive.
func (s *Supervisor) RestartExclusive(ctx context.Context, cfg config.Veil, token string) error {
	return s.restartLocked(ctx, cfg, token)
}

// Apply starts the candidate. It restores the previous configuration when the candidate fails.
func (s *Supervisor) Apply(ctx context.Context, candidate config.Veil, previous *config.Veil, token string) error {
	if !s.actionMu.TryLock() {
		return ErrBusy
	}
	defer s.actionMu.Unlock()
	if err := s.stopLocked(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	if err := s.startLocked(ctx, candidate, token); err == nil {
		return nil
	}
	if previous != nil {
		if rollbackErr := s.startLocked(context.Background(), *previous, token); rollbackErr != nil {
			return errors.New("candidate failed and the known-good configuration could not restart")
		}
	}
	return errors.New("candidate failed; the known-good configuration was restored")
}

// waitForLive polls Veil's unauthenticated /livez until the process accepts
// connections. It says nothing about the model runtime, which is deliberate.
func waitForLive(ctx context.Context, address string) error {
	endpoint := "http://" + address + "/livez"
	client := &http.Client{Timeout: 2 * time.Second}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// healthProbe asks /api/health once: whether Veil can currently reach its
// configured runtime. It colors the status line, never the start outcome.
func healthProbe(ctx context.Context, address, token string) bool {
	endpoint := "http://" + address + "/api/health"
	client := &http.Client{Timeout: 2 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// FetchOpsMetrics returns administrator-safe Veil operational counters.
func (s *Supervisor) FetchOpsMetrics(ctx context.Context, token string) OpsMetrics {
	status := s.Status()
	if !status.Healthy || strings.TrimSpace(token) == "" {
		return OpsMetrics{}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+s.veilAddress+"/api/runtime/metrics", nil)
	if err != nil {
		return OpsMetrics{}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return OpsMetrics{}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return OpsMetrics{}
	}
	var body struct {
		ActiveRequests     int64   `json:"active_requests"`
		QueueDepth         int64   `json:"queue_depth"`
		QueueWaitMsAvg     float64 `json:"queue_wait_ms_avg"`
		OverloadCount      uint64  `json:"overload_count"`
		CancelCount        uint64  `json:"cancel_count"`
		TimeoutCount       uint64  `json:"timeout_count"`
		ReleaseErrorCount  uint64  `json:"release_error_count"`
		TrackedUsers       int     `json:"tracked_users"`
		GlobalLimit        int     `json:"global_limit"`
		PerUserLimit       int     `json:"per_user_limit"`
		PrefixCacheHitRate float64 `json:"prefix_cache_hit_rate"`
		RuntimeQueueDepth  float64 `json:"runtime_queue_depth"`
		RuntimeState       string  `json:"runtime_state"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body); err != nil {
		return OpsMetrics{}
	}
	return OpsMetrics{
		Available:      true,
		ActiveRequests: body.ActiveRequests,
		QueueDepth:     body.QueueDepth,
		QueueWaitMsAvg: body.QueueWaitMsAvg,
		OverloadCount:  body.OverloadCount,
		CancelCount:    body.CancelCount,
		TimeoutCount:   body.TimeoutCount,
		GlobalLimit:    body.GlobalLimit,
		PerUserLimit:   body.PerUserLimit,
		ReleaseErrors:  body.ReleaseErrorCount,
		TrackedUsers:   body.TrackedUsers,
		RuntimeState:   body.RuntimeState,
		PrefixCacheHit: body.PrefixCacheHitRate,
		RuntimeQueue:   body.RuntimeQueueDepth,
	}
}

type safeBuffer struct {
	mu      sync.Mutex
	limit   int
	data    []byte
	pending []byte
	secrets []string
}

func newSafeBuffer(limit int) *safeBuffer { return &safeBuffer{limit: limit} }

func (b *safeBuffer) SetSecrets(values ...string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.secrets = b.secrets[:0]
	for _, value := range values {
		if value != "" {
			b.secrets = append(b.secrets, value)
		}
	}
}

func (b *safeBuffer) Write(payload []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pending = append(b.pending, payload...)
	for {
		newline := bytes.IndexByte(b.pending, '\n')
		if newline < 0 {
			break
		}
		b.appendRedactedLine(string(b.pending[:newline]))
		b.pending = b.pending[newline+1:]
	}
	if len(b.pending) > 8<<10 {
		b.appendRedactedLine(string(b.pending))
		b.pending = b.pending[:0]
	}
	return len(payload), nil
}

func (b *safeBuffer) appendRedactedLine(line string) {
	redacted := line
	for _, secret := range b.secrets {
		redacted = strings.ReplaceAll(redacted, secret, "[redacted]")
	}
	if strings.Contains(strings.ToUpper(redacted), "AUTHORIZATION") || strings.Contains(strings.ToUpper(redacted), "API_KEY") || strings.Contains(strings.ToUpper(redacted), "AUTH_TOKEN") {
		redacted = "[redacted sensitive log line]"
	}
	b.data = append(b.data, redacted...)
	b.data = append(b.data, '\n')
	if len(b.data) > b.limit {
		b.data = append([]byte(nil), b.data[len(b.data)-b.limit:]...)
	}
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(append([]byte(nil), b.data...))
}

// String is the service state as the dashboard prints it. Every state reads as
// a capitalized word, the same rule the per-model card follows: this is a
// heading in the interface, not a log line.
func (s Status) String() string {
	if s.Healthy {
		return fmt.Sprintf("Healthy (PID %d)", s.PID)
	}
	if s.Running {
		// A running process with an unavailable runtime says so, rather than
		// claiming to still be starting.
		if s.Message != "" && s.Message != "Starting" {
			return fmt.Sprintf("%s (PID %d)", s.Message, s.PID)
		}
		return fmt.Sprintf("Starting (PID %d)", s.PID)
	}
	if s.Message != "" {
		return s.Message
	}
	return "Stopped"
}
