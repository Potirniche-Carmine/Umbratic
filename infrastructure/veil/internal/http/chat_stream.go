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
	streamErr := model.WriteOpenAIChatSSE(ctx, s.cfg.Mode, observer, resp.Body, s.cfg.StreamIdleTimeout, annotation)
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
