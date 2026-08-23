package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"umbratic-veil/internal/model"
	"umbratic-veil/internal/prompts"
)

// keepAliveInterval is how often an SSE comment goes out while the runtime is
// still prefilling. Well under the sixty seconds a proxy typically allows an
// idle connection, and it stops at the first real frame.
const keepAliveInterval = 20 * time.Second

// protectedPrefixKey identifies one assembled prefix. The route, the rendered
// playbook, and the skill catalog are all inputs to it, so hashing the
// assembled messages covers every one of them without tracking each
// separately: a catalog change is a different key and forces a recount.
func protectedPrefixKey(route prompts.Route, prefix []model.Message) string {
	encoded, err := json.Marshal(prefix)
	if err != nil {
		return ""
	}
	return string(route) + ":" + fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func (s *Server) streamChat(w http.ResponseWriter, ctx context.Context, route prompts.Route, req model.ChatRequest, annotation model.UsageAnnotation) {
	startedAt := time.Now()
	resp, err := s.attemptChatStream(ctx, req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			s.admission.recordCancel()
		}
		failure := classifyModelFailure(err, 0)
		s.noteModelFailure(failure)
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

	go func() {
		<-ctx.Done()
		_ = resp.Body.Close()
	}()

	observer := &firstWriteObserver{
		dst:     w,
		started: startedAt,
		onFirst: s.stream.timeToFirstToken.observe,
	}
	keepAliveStop := make(chan struct{})
	keepAliveDone := make(chan struct{})
	go func() {
		defer close(keepAliveDone)
		ticker := time.NewTicker(keepAliveInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-keepAliveStop:
				return
			case <-ticker.C:
				// Returns false once the first real frame has gone out, which
				// is when the stream itself is proof enough of liveness.
				if !observer.writeKeepAlive() {
					return
				}
			}
		}
	}()

	streamErr := model.WriteOpenAIChatSSE(ctx, s.cfg.Mode, observer, resp.Body, s.cfg.StreamIdleTimeout, annotation, req.ReasoningVisible)
	// The keep-alive shares the response writer, so it must be finished before
	// anything below writes an error frame.
	close(keepAliveStop)
	<-keepAliveDone
	s.stream.streamDuration.observe(time.Since(startedAt))
	if err := streamErr; err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			s.admission.recordCancel()
			s.stream.disconnects.Add(1)
			return
		}
		s.stream.invalidStreams.Add(1)
		failure := modelFailure{Status: http.StatusBadGateway, Code: "model_service_stream_incomplete", Message: "model service stream ended unexpectedly"}
		if errors.Is(err, context.DeadlineExceeded) {
			failure = modelFailure{Status: http.StatusGatewayTimeout, Code: "model_service_timeout", Message: "model service timed out"}
			s.noteModelFailure(failure)
		} else {
			var providerError model.ProviderError
			if errors.As(err, &providerError) && providerError.Kind == model.ProviderFailureTimeout {
				failure = modelFailure{Status: http.StatusGatewayTimeout, Code: "model_service_timeout", Message: "model service timed out"}
				s.noteModelFailure(failure)
			}
		}
		recordModelFailure(route, "response_stream", failure, req, time.Since(startedAt))
		encoded, _ := json.Marshal(map[string]string{"error": failure.Message, "code": failure.Code})
		_, _ = io.WriteString(w, "event: error\ndata: "+string(encoded)+"\n\n")
	}
}
