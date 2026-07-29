package supervisor

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
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

type Status struct {
	Running bool
	Healthy bool
	PID     int
	Message string
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
	s.logs.SetSecrets(token, s.internalToken)
	cmd := exec.Command(s.binary)
	configureProcess(cmd)
	healthToken := token
	if s.entitlementPath != "" {
		cmd.Env = cfg.CompanyEnvironment(s.veilAddress, s.internalToken, token, s.entitlementPath, s.identityStorePath)
	} else {
		cmd.Env = cfg.Environment(s.veilAddress, token)
	}
	cmd.Stdout, cmd.Stderr = s.logs, s.logs
	if err := cmd.Start(); err != nil {
		return errors.New("Veil did not start")
	}
	s.stateMu.Lock()
	s.cmd = cmd
	s.status = Status{Running: true, PID: cmd.Process.Pid, Message: "starting"}
	s.stateMu.Unlock()
	go s.wait(cmd)
	healthCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := waitForHealth(healthCtx, s.veilAddress, healthToken); err != nil {
		_ = s.stopLocked(context.Background())
		return errors.New("Veil health check failed")
	}
	s.stateMu.Lock()
	if s.cmd == cmd {
		s.status.Healthy = true
		s.status.Message = "healthy"
	}
	s.stateMu.Unlock()
	return nil
}

func (s *Supervisor) wait(cmd *exec.Cmd) {
	err := cmd.Wait()
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.cmd != cmd {
		return
	}
	s.cmd = nil
	s.status.Running = false
	s.status.Healthy = false
	s.status.PID = 0
	if err != nil {
		s.status.Message = "Veil exited unexpectedly"
	} else {
		s.status.Message = "stopped"
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

func waitForHealth(ctx context.Context, address, token string) error {
	endpoint := "http://" + address + "/api/health"
	client := &http.Client{Timeout: 2 * time.Second}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		req.Header.Set("Authorization", "Bearer "+token)
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

func (s Status) String() string {
	if s.Healthy {
		return fmt.Sprintf("healthy (PID %d)", s.PID)
	}
	if s.Running {
		return fmt.Sprintf("starting (PID %d)", s.PID)
	}
	if s.Message != "" {
		return s.Message
	}
	return "stopped"
}
