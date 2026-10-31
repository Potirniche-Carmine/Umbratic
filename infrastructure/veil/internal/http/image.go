package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"umbratic-veil/internal/model"
	"umbratic-veil/internal/policy"
)

type imageGenerator interface {
	Generate(context.Context, model.ImageRequest) ([]byte, error)
}

func (s *Server) handleImage(w http.ResponseWriter, r *http.Request) {
	if s.image == nil {
		writeCodedError(w, http.StatusNotFound, "image_unconfigured", "Image generation is not configured.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 24<<10)
	var raw map[string]json.RawMessage
	decoder := json.NewDecoder(r.Body)
	if decoder.Decode(&raw) != nil || raw == nil || decoder.Decode(new(any)) != io.EOF {
		writeCodedError(w, http.StatusBadRequest, "invalid_image_request", "Invalid image request.")
		return
	}
	input, err := policy.DecodeImageInput(raw)
	if err != nil {
		writeCodedError(w, http.StatusBadRequest, "invalid_image_request", "Use a prompt of at most 8000 bytes and dimensions from 256 to 1024 in multiples of 32. Protected overrides are not allowed.")
		return
	}
	select {
	case s.imageSlot <- struct{}{}:
		defer func() { <-s.imageSlot }()
	default:
		writeCodedError(w, http.StatusTooManyRequests, "image_busy", "An image is already being generated.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()
	stop := context.AfterFunc(s.imageContext, cancel)
	defer stop()
	image, err := s.image.Generate(ctx, input)
	if err != nil {
		writeCodedError(w, http.StatusBadGateway, "image_failed", "Image generation failed. Try a smaller image or free some memory.")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(image)
}
