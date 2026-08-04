package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync/atomic"

	"umbratic-veil/internal/model"
)

// retryCount is diagnostic. A rising value means the runtime is dropping
// connections before it answers, not that the harness is working harder.
var retryCount atomic.Uint64

// attemptChatStream opens the provider stream, retrying at most once and only
// while the request is not yet semantically committed.
//
// Committed means anything the caller could already have acted on: forwarded
// assistant text, an accepted tool call, or an executed tool. Opening the
// connection commits nothing, so a transport failure or a retryable upstream
// status there can be retried safely. Once a body is returned this function is
// done — everything after it streams, and streaming is never retried.
func (s *Server) attemptChatStream(ctx context.Context, req model.ChatRequest) (*http.Response, error) {
	resp, err := s.model.DoChat(ctx, req)
	if !retryableStreamStart(ctx, resp, err) {
		return resp, err
	}
	if resp != nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
	}
	retryCount.Add(1)
	return s.model.DoChat(ctx, req)
}

// retryableStreamStart reports whether the first attempt failed in a way that
// is safe to repeat. A canceled caller is never retried, and neither is a
// status the runtime will answer the same way twice.
func retryableStreamStart(ctx context.Context, resp *http.Response, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	if err != nil {
		// A timeout means the runtime is loaded; repeating it adds load without
		// improving the odds.
		var providerError model.ProviderError
		if errors.As(err, &providerError) && providerError.Kind == model.ProviderFailureTimeout {
			return false
		}
		return true
	}
	if resp == nil {
		return false
	}
	switch resp.StatusCode {
	case http.StatusBadGateway, http.StatusServiceUnavailable:
		return true
	default:
		return false
	}
}
