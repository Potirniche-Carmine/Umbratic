package supervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
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
	binary      string
	veilAddress string
	actionMu    sync.Mutex
	stateMu     sync.RWMutex
	cmd         *exec.Cmd
	status      Status
	logs        *safeBuffer
}

func New(binary, veilAddress string) *Supervisor {
	return &Supervisor{binary: binary, veilAddress: veilAddress, logs: newSafeBuffer(32 << 10)}
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
	s.logs.SetSecrets(token)
	cmd := exec.Command(s.binary)
	configureProcess(cmd)
	cmd.Env = cfg.Environment(s.veilAddress, token)
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
	if err := waitForHealth(healthCtx, s.veilAddress, token); err != nil {
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
	if err := s.stopLocked(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return s.startLocked(ctx, cfg, token)
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

func TestProvider(ctx context.Context, cfg config.Veil) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	testCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	base, _ := url.Parse(cfg.ProviderBaseURL)
	host := base.Hostname()
	resolver := net.DefaultResolver
	addresses, err := resolver.LookupIPAddr(testCtx, host)
	if err != nil || len(addresses) == 0 {
		return errors.New("provider host could not be resolved")
	}
	for _, address := range addresses {
		if !allowedProviderIP(address.IP) {
			return errors.New("provider host must resolve only to loopback or private addresses")
		}
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(dialCtx context.Context, network, destination string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(destination)
			if err != nil {
				return nil, errors.New("provider destination is invalid")
			}
			for _, address := range addresses {
				if !allowedProviderIP(address.IP) {
					continue
				}
				conn, dialErr := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(dialCtx, network, net.JoinHostPort(address.IP.String(), port))
				if dialErr == nil {
					return conn, nil
				}
			}
			return nil, errors.New("provider connection failed")
		},
		TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 5 * time.Second,
	}
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return errors.New("provider redirects are not allowed")
	}}
	path := "/v1/models"
	if cfg.Protocol == "ollama" {
		path = "/api/tags"
	}
	base.Path = providerPath(base.Path, path)
	request, _ := http.NewRequestWithContext(testCtx, http.MethodGet, base.String(), nil)
	resp, err := client.Do(request)
	if err != nil {
		return errors.New("provider health test failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return errors.New("provider health test failed")
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || !json.Valid(payload) {
		return errors.New("provider returned an invalid response")
	}
	if !containsModel(payload, cfg.Model) {
		return errors.New("selected model is not available")
	}
	return nil
}

func providerPath(basePath, endpoint string) string {
	basePath = strings.TrimRight(basePath, "/")
	lastSlash := strings.LastIndex(endpoint, "/")
	if lastSlash > 0 && strings.HasSuffix(basePath, endpoint[:lastSlash]) {
		return basePath + endpoint[lastSlash:]
	}
	return basePath + endpoint
}

func containsModel(payload []byte, selected string) bool {
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return false
	}
	var visit func(any) bool
	visit = func(current any) bool {
		switch typed := current.(type) {
		case map[string]any:
			for key, child := range typed {
				if (key == "id" || key == "name" || key == "model") && child == selected {
					return true
				}
				if visit(child) {
					return true
				}
			}
		case []any:
			for _, child := range typed {
				if visit(child) {
					return true
				}
			}
		}
		return false
	}
	return visit(value)
}

func allowedProviderIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
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
