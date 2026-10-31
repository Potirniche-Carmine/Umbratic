package httpapi

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
)

// lifecycle separates readiness from liveness.
//
// A process that is up is not necessarily able to serve: the model runtime may
// not have answered yet, or the process may be shutting down. Restarts under
// load previously accepted work immediately and cut active streams; with an
// explicit state, an unready process refuses new model work with a typed code
// and a draining one stops accepting while in-flight streams finish.
type lifecycle struct {
	ready    atomic.Bool
	draining atomic.Bool
}

var errModelUnavailable = errors.New("configured model is unavailable")

type lifecycleState string

const (
	lifecycleStarting lifecycleState = "starting"
	lifecycleReady    lifecycleState = "ready"
	lifecycleDraining lifecycleState = "draining"
)

func (l *lifecycle) state() lifecycleState {
	switch {
	case l.draining.Load():
		return lifecycleDraining
	case l.ready.Load():
		return lifecycleReady
	default:
		return lifecycleStarting
	}
}

func (l *lifecycle) markReady() {
	if l.draining.Load() {
		return
	}
	l.ready.Store(true)
}

// beginDrain stops new model work. In-flight requests keep their slots and are
// allowed to finish by the server's own shutdown deadline.
func (l *lifecycle) beginDrain() {
	l.draining.Store(true)
	l.ready.Store(false)
}

// acceptsModelWork is false only while draining.
//
// Draining is a correctness gate: a process that is shutting down must not take
// work it cannot finish. Readiness is deliberately *not* a gate — a process that
// refuses traffic until a probe succeeds can deadlock behind a slow or flaky
// runtime, which is a worse failure than briefly forwarding a request that the
// runtime itself will reject. Readiness is reported instead, so a load balancer
// or the Console can route around a cold instance.
func (l *lifecycle) acceptsModelWork() bool {
	return !l.draining.Load()
}

// Warm probes the configured model once and marks the server ready. It is safe
// to call repeatedly; readiness latches on the first success.
func (s *Server) Warm(ctx context.Context) error {
	available, err := s.configuredModelAvailable(ctx)
	if err != nil {
		return err
	}
	if !available {
		return errModelUnavailable
	}
	s.lifecycle.markReady()
	return nil
}

// BeginDrain refuses new model work so a restart does not accept requests it
// cannot finish. Call it before the HTTP server's graceful shutdown.
func (s *Server) BeginDrain() {
	s.imageCancel()
	s.lifecycle.beginDrain()
}

// guardLifecycle refuses model work while the server is draining. Returns false
// when it has already written a response.
func (s *Server) guardLifecycle(w http.ResponseWriter) bool {
	if s.lifecycle.acceptsModelWork() {
		return true
	}
	w.Header().Set("Retry-After", "1")
	writeCodedError(w, http.StatusServiceUnavailable, "draining", "Veil is shutting down. Retry against a healthy instance.")
	return false
}
