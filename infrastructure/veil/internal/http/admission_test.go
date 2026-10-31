package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"umbratic-veil/internal/model"
)

func TestAdmissionDoesNotReserveCapacityForCancelledRequests(t *testing.T) {
	for _, user := range []string{"", "user-1"} {
		t.Run(user, func(t *testing.T) {
			controller := newAdmissionController(2, 1, time.Second)
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			lease, err := controller.acquire(ctx, user)
			if lease != nil {
				lease.release()
				t.Fatal("cancelled request acquired a model slot")
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("expected cancellation, got %v", err)
			}
			if len(controller.global) != 0 || controller.trackedUsers() != 0 || controller.activeRequests.Load() != 0 || controller.queueDepth.Load() != 0 {
				t.Fatal("cancelled request retained capacity or a user bucket")
			}
			if controller.cancelCount.Load() != 1 {
				t.Fatal("cancellation was not counted")
			}
		})
	}
}

func TestAdmissionRejectsWhenGlobalCapacityIsSaturated(t *testing.T) {
	cfg := testConfig()
	cfg.RequestTimeout = 5 * time.Second
	cfg.Generation.MaxConcurrentRequests = 1
	cfg.Generation.MaxConcurrentRequestsUser = 1
	cfg.Generation.QueueTimeout = 50 * time.Millisecond

	started := make(chan struct{}, 1)
	release := make(chan struct{})
	server := NewServer(cfg, &blockingModelClient{started: started, release: release})

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hold"}`))
		req.Header.Set("Authorization", "Bearer test-token")
		rr := httptest.NewRecorder()
		server.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Errorf("holder failed: %d %s", rr.Code, rr.Body.String())
		}
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("holder never started model work")
	}

	busy := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"busy"}`))
	busy.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, busy)
	if rr.Code != http.StatusServiceUnavailable || !strings.Contains(rr.Body.String(), `"code":"busy"`) {
		t.Fatalf("expected busy response, got %d %s", rr.Code, rr.Body.String())
	}
	if rr.Header().Get("Retry-After") == "" {
		t.Fatal("busy response missing Retry-After")
	}

	close(release)
	wg.Wait()
}

func TestAdmissionUsesGlobalBucketOnlyWithoutUserIdentity(t *testing.T) {
	cfg := testConfig()
	cfg.RequestTimeout = 5 * time.Second
	cfg.Generation.MaxConcurrentRequests = 2
	cfg.Generation.MaxConcurrentRequestsUser = 1
	cfg.Generation.QueueTimeout = 50 * time.Millisecond
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	server := NewServer(cfg, &blockingModelClient{started: started, release: release})

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hold"}`))
			req.Header.Set("Authorization", "Bearer test-token")
			rr := httptest.NewRecorder()
			server.ServeHTTP(rr, req)
			if rr.Code != http.StatusOK {
				t.Errorf("holder failed: %d %s", rr.Code, rr.Body.String())
			}
		}()
	}
	deadline := time.After(2 * time.Second)
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-deadline:
			t.Fatal("expected both global slots without per-user identity")
		}
	}
	close(release)
	wg.Wait()
}

func TestAdmissionMetricsReflectOverload(t *testing.T) {
	cfg := testConfig()
	cfg.RequestTimeout = 5 * time.Second
	cfg.Generation.MaxConcurrentRequests = 1
	cfg.Generation.MaxConcurrentRequestsUser = 1
	cfg.Generation.QueueTimeout = 20 * time.Millisecond
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	server := NewServer(cfg, &blockingModelClient{started: started, release: release})

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		req := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"hold"}`))
		req.Header.Set("Authorization", "Bearer test-token")
		server.ServeHTTP(httptest.NewRecorder(), req)
	}()
	<-started
	busy := httptest.NewRequest(http.MethodPost, "/api/engineering/chat", strings.NewReader(`{"input":"busy"}`))
	busy.Header.Set("Authorization", "Bearer test-token")
	server.ServeHTTP(httptest.NewRecorder(), busy)

	metricsReq := httptest.NewRequest(http.MethodGet, "/api/runtime/metrics", nil)
	metricsReq.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	server.ServeHTTP(rr, metricsReq)
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["active_requests"] != float64(1) || body["overload_count"].(float64) < 1 {
		t.Fatalf("expected active and overload counters, got %#v", body)
	}
	close(release)
	wg.Wait()
}

type blockingModelClient struct {
	fakeModelClient
	started chan struct{}
	release chan struct{}
}

// Chat deliberately does not record req: admission tests drive this client from
// several goroutines at once and never inspect the recorded request.
func (c *blockingModelClient) Chat(ctx context.Context, _ model.ChatRequest) (model.ChatResponse, error) {
	select {
	case c.started <- struct{}{}:
	default:
	}
	select {
	case <-c.release:
		return model.ChatResponse{Message: model.Message{Role: "assistant", Content: "ok"}}, nil
	case <-ctx.Done():
		return model.ChatResponse{}, ctx.Err()
	}
}

func TestAdmissionEvictsIdleUserBucketsAndCountsDoubleRelease(t *testing.T) {
	controller := newAdmissionController(4, 2, time.Second)
	first, err := controller.acquire(context.Background(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := controller.acquire(context.Background(), "user-b")
	if err != nil {
		t.Fatal(err)
	}
	if got := controller.trackedUsers(); got != 2 {
		t.Fatalf("expected 2 tracked users, got %d", got)
	}
	first.release()
	second.release()
	if got := controller.trackedUsers(); got != 0 {
		t.Fatalf("idle user buckets were not evicted, %d remain", got)
	}
	if got := controller.snapshot().ReleaseErrorCount; got != 0 {
		t.Fatalf("clean releases must not be counted as errors, got %d", got)
	}

	controller.releaseSlot(controller.global)
	if got := controller.snapshot().ReleaseErrorCount; got != 1 {
		t.Fatalf("expected a counted double release, got %d", got)
	}
}

func (c *blockingModelClient) PrefixTokens(context.Context, string, string, []model.Message) model.UsageAnnotation {
	return model.UsageAnnotation{}
}
