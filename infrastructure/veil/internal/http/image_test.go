package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"umbratic-veil/internal/model"
)

type fakeImage func(context.Context, model.ImageRequest) ([]byte, error)

func (f fakeImage) Generate(ctx context.Context, input model.ImageRequest) ([]byte, error) {
	return f(ctx, input)
}

func TestImageRouteAuthenticationBoundsRedactionAndAbsence(t *testing.T) {
	cfg := testConfig()
	cfg.Image = &model.ImageRuntime{}
	s := NewServer(cfg, &fakeModelClient{})
	s.lifecycle.markReady()
	calls := 0
	s.image = fakeImage(func(_ context.Context, input model.ImageRequest) ([]byte, error) {
		calls++
		if input.Prompt != "sphere" || input.Width != 512 {
			t.Fatalf("wrong request: %+v", input)
		}
		return []byte("png-result"), nil
	})
	for _, row := range []struct {
		token, body string
		want        int
	}{
		{"", `{"prompt":"sphere"}`, 401},
		{cfg.AuthToken, `{"prompt":"sphere","future_field":true}`, 200},
		{cfg.AuthToken, `{"prompt":"sphere","system":"private"}`, 400},
		{cfg.AuthToken, `{"prompt":"sphere","width":10000}`, 400},
		{cfg.AuthToken, `{"prompt":"sphere"} {}`, 400},
		{cfg.AuthToken, `{"prompt":"` + strings.Repeat("x", 25000) + `"}`, 400},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/images/generate", strings.NewReader(row.body))
		req.Header.Set("Authorization", "Bearer "+row.token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		if w.Code != row.want {
			t.Fatalf("got %d want %d: %s", w.Code, row.want, w.Body)
		}
		if w.Code == 200 && (w.Header().Get("Content-Type") != "image/png" || w.Header().Get("Cache-Control") != "no-store") {
			t.Fatal("missing image headers")
		}
	}
	if calls != 1 {
		t.Fatalf("invalid requests reached runtime: %d", calls)
	}
	s.image = fakeImage(func(context.Context, model.ImageRequest) ([]byte, error) {
		return nil, errors.New("secret prompt /private/model /tmp/file")
	})
	req := httptest.NewRequest(http.MethodPost, "/api/images/generate", strings.NewReader(`{"prompt":"sphere"}`))
	req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != 502 || strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "/tmp") {
		t.Fatalf("unsafe runtime failure: %s", w.Body)
	}
	s.image = nil
	req = httptest.NewRequest(http.MethodPost, "/api/images/generate", strings.NewReader(`{"prompt":"sphere"}`))
	req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("unconfigured: %d", w.Code)
	}
}

func TestImageDrainCancelsGenerationAndRefusesConcurrentWork(t *testing.T) {
	cfg := testConfig()
	cfg.Image = &model.ImageRuntime{}
	s := NewServer(cfg, &fakeModelClient{})
	s.lifecycle.markReady()
	started, done := make(chan struct{}), make(chan struct{})
	s.image = fakeImage(func(ctx context.Context, _ model.ImageRequest) ([]byte, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	request := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/images/generate", strings.NewReader(`{"prompt":"sphere"}`))
		req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		return w
	}
	go func() { defer close(done); request() }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("generation did not start")
	}
	if result := request(); result.Code != 429 {
		t.Fatalf("concurrent generation: %d", result.Code)
	}
	s.BeginDrain()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("drain did not cancel generation")
	}
	if len(s.imageSlot) != 0 {
		t.Fatal("generation slot leaked")
	}
}
