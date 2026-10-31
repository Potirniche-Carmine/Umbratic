package supervisor

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
	"umbratic-veil-console/internal/config"
)

// Proxy owns the fixed Caddy child. Configuration, restart, persistence, and
// enrollment snapshots share one lock so codes cannot advertise a candidate.
type Proxy struct {
	lifetime                       context.Context
	cancel                         context.CancelFunc
	mu                             sync.Mutex
	binary, directory, veilAddress string
	consolePort, veilPort          int
	current                        config.Connection
	command                        *exec.Cmd
	done                           chan struct{}
	ready                          bool
	closed                         bool
}

func NewProxy(binary, directory, veilAddress string, consolePort int, current config.Connection) *Proxy {
	_, port, _ := net.SplitHostPort(veilAddress)
	veilPort, _ := strconv.Atoi(port)
	lifetime, cancel := context.WithCancel(context.Background())
	return &Proxy{lifetime: lifetime, cancel: cancel, binary: binary, directory: directory, veilAddress: veilAddress, consolePort: consolePort, veilPort: veilPort, current: current}
}
func (p *Proxy) Available() bool { return p.binary != "" }
func (p *Proxy) Snapshot() (config.Connection, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.current, p.runningLocked() && p.ready
}
func (p *Proxy) runningLocked() bool {
	if p.done == nil {
		return false
	}
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}
func (p *Proxy) CAPath() string {
	return filepath.Join(p.directory, ".local", "share", "caddy", "pki", "authorities", "local", "root.crt")
}
func (p *Proxy) Enrollment() (config.Connection, []byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.ready || !p.runningLocked() {
		return p.current, nil, errors.New("configure a working connection on the Veil page first")
	}
	if p.current.TLS == "public" {
		return p.current, nil, nil
	}
	data, err := os.ReadFile(p.CAPath())
	return p.current, data, err
}
func (p *Proxy) Start(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return errors.New("Console is shutting down")
	}
	if p.runningLocked() {
		return nil
	}
	return p.startLocked(ctx, p.current)
}
func (p *Proxy) Apply(ctx context.Context, c config.Connection, persist func(config.Connection) error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return errors.New("Console is shutting down")
	}
	if err := c.Validate(p.consolePort, p.veilPort); err != nil {
		return err
	}
	previous := p.current
	p.stopLocked()
	err := p.startLocked(ctx, c)
	if err == nil {
		err = persist(c)
	}
	if err == nil {
		p.current = c
		return nil
	}
	p.stopLocked()
	rollback, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if restoreErr := p.startLocked(rollback, previous); restoreErr != nil {
		return fmt.Errorf("%w; previous connection could not restart; correct the settings and apply again", err)
	}
	return fmt.Errorf("%w; previous connection restored", err)
}
func (p *Proxy) Stop() {
	p.cancel()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	p.stopLocked()
}
func (p *Proxy) stopLocked() {
	p.ready = false
	if p.runningLocked() {
		requestProcessStop(p.command)
		select {
		case <-p.done:
		case <-time.After(2 * time.Second):
			_ = p.command.Process.Kill()
			<-p.done
		}
	}
	p.command, p.done = nil, nil
}
func (p *Proxy) startLocked(ctx context.Context, c config.Connection) error {
	if err := c.Validate(p.consolePort, p.veilPort); err != nil {
		return err
	}
	if p.binary == "" {
		return errors.New("HTTPS is unavailable in this installation")
	}
	file := filepath.Join(p.directory, "Caddyfile")
	if err := os.WriteFile(file, []byte(c.Caddyfile(p.veilAddress)), 0600); err != nil {
		return errors.New("could not write the HTTPS configuration")
	}
	command := exec.Command(p.binary, "run", "--config", file, "--adapter", "caddyfile")
	command.Dir = p.directory
	command.Env = []string{"HOME=" + p.directory, "XDG_DATA_HOME=" + filepath.Join(p.directory, ".local", "share"), "XDG_CONFIG_HOME=" + filepath.Join(p.directory, ".config"), "PATH=/usr/bin:/bin"}
	// A file avoids pipe workers and keeps private runtime details out of pages.
	log, err := os.OpenFile(filepath.Join(p.directory, "caddy.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("could not open the HTTPS log")
	}
	command.Stdout, command.Stderr = log, log
	configureProcess(command)
	err = command.Start()
	_ = log.Close()
	if err != nil {
		return errors.New("HTTPS could not start")
	}
	p.command, p.done = command, make(chan struct{})
	done := p.done
	go func() { _ = command.Wait(); close(done) }()
	err = p.waitReady(ctx, c)
	if err != nil {
		p.stopLocked()
		return err
	}
	p.ready = true
	return nil
}
func (p *Proxy) waitReady(ctx context.Context, c config.Connection) error {
	timeout := 15 * time.Second
	if c.TLS == "public" {
		timeout = 90 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stop := context.AfterFunc(p.lifetime, cancel)
	defer stop()
	for {
		if !p.runningLocked() {
			return errors.New("HTTPS stopped; check the address, port, and certificate settings")
		}
		if p.probe(ctx, c) == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("HTTPS could not be verified; check the port and certificate validation access")
		case <-time.After(200 * time.Millisecond):
		}
	}
}
func (p *Proxy) probe(ctx context.Context, c config.Connection) error {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if c.TLS == "internal" {
		data, err := os.ReadFile(p.CAPath())
		if err != nil {
			return err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(data) {
			return errors.New("invalid HTTPS certificate")
		}
		tlsConfig.RootCAs = pool
	}
	transport := &http.Transport{TLSClientConfig: tlsConfig, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port)))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, path := range []string{"/api/control", "/api/control/users"} {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.URL()+path, nil)
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			return errors.New("HTTPS must block the control API")
		}
	}
	return nil
}
