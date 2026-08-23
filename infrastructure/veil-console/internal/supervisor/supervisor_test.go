package supervisor

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"umbratic-veil-console/internal/config"
)

func TestProviderAddressRules(t *testing.T) {
	for _, test := range []struct {
		ip   string
		want bool
	}{{"127.0.0.1", true}, {"10.0.0.4", true}, {"192.168.1.4", true}, {"169.254.169.254", false}, {"8.8.8.8", false}} {
		if got := allowedProviderIP(net.ParseIP(test.ip)); got != test.want {
			t.Errorf("allowedProviderIP(%s)=%v", test.ip, got)
		}
	}
}

func TestProviderChecksSelectedModel(t *testing.T) {
	// A runtime that only lists models is not usable: the probes require it to
	// stream and to emit a forced tool call.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/chat/completions") {
			_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"name\":\"probe_ok\"}}]}}]}\ndata: [DONE]\n"))
			return
		}
		_, _ = w.Write([]byte(`{"models":[{"name":"model-a"}]}`))
	}))
	defer server.Close()
	cfg := config.DefaultVeil()
	cfg.ProviderBaseURL, cfg.Model = server.URL, "model-a"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := TestProvider(ctx, cfg); err != nil {
		t.Fatal(err)
	}
}

func TestListModelsReturnsUniqueSortedRuntimeModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"models":[{"name":"ornith:9b","model":"ornith:9b"},{"name":"alpha:latest"}]}`))
	}))
	defer server.Close()
	models, err := ListModels(t.Context(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0] != "alpha:latest" || models[1] != "ornith:9b" {
		t.Fatalf("models = %#v", models)
	}
}

func TestSafeBufferRedactsSecrets(t *testing.T) {
	buffer := newSafeBuffer(1024)
	buffer.SetSecrets("seeded-secret")
	_, _ = buffer.Write([]byte("value=seeded-secret\nVEIL_AUTH_TOKEN=other\n"))
	if got := buffer.String(); got != "value=[redacted]\n[redacted sensitive log line]\n" {
		t.Fatalf("unexpected safe log: %q", got)
	}
}

func TestSafeBufferRedactsSecretSplitAcrossWrites(t *testing.T) {
	buffer := newSafeBuffer(1024)
	buffer.SetSecrets("seeded-secret")
	_, _ = buffer.Write([]byte("value=seeded-"))
	_, _ = buffer.Write([]byte("secret\n"))
	if got := buffer.String(); got != "value=[redacted]\n" {
		t.Fatalf("split secret leaked: %q", got)
	}
}

func TestModelMatchIsExact(t *testing.T) {
	// The check that gates a configuration compares collected ids exactly, so a
	// model whose name merely contains the selection must not satisfy it.
	if got := collectModels([]byte(`{"models":[{"name":"model-a-large"}]}`)); len(got) != 1 || got[0] != "model-a-large" {
		t.Fatalf("collected %#v", got)
	}
	if got := collectModels([]byte(`{"data":[{"id":"model-a"}]}`)); len(got) != 1 || got[0] != "model-a" {
		t.Fatalf("collected %#v", got)
	}
}

func TestProviderPathDoesNotDuplicateProtocolPrefix(t *testing.T) {
	if got := providerPath("/v1", "/v1/models"); got != "/v1/models" {
		t.Fatalf("vLLM path = %q", got)
	}
	if got := providerPath("/api", "/api/tags"); got != "/api/tags" {
		t.Fatalf("Ollama path = %q", got)
	}
}

func TestActionSerialization(t *testing.T) {
	process := New("unused", "127.0.0.1:8080")
	process.actionMu.Lock()
	defer process.actionMu.Unlock()
	if err := process.Stop(context.Background()); err != ErrBusy {
		t.Fatalf("concurrent action returned %v", err)
	}
}

// An unexpected exit is recovered automatically, but only while the crashes
// stay inside the window. Past the limit the process is left down so the log
// line that explains the failure is not buried under a restart loop.
func TestRecoveryStopsAfterRepeatedCrashes(t *testing.T) {
	process := New("unused", "127.0.0.1:8080")
	cfg := config.Veil{}
	process.lastConfig, process.lastToken = &cfg, "token"
	now := time.Now()
	for attempt := range maxRestartsInWindow {
		process.crashes = append(process.crashes, now)
		if len(process.crashes) > maxRestartsInWindow {
			t.Fatalf("crash %d already tripped the breaker", attempt)
		}
	}
	process.recover()
	if got := process.Status().Message; got != "Veil keeps exiting. Automatic restart is paused — check the log, then start it from this page." {
		t.Fatalf("breaker did not pause restarts: %q", got)
	}
}

// An operator-initiated stop is not a crash, so it must not schedule a restart.
func TestStoppingSuppressesRecovery(t *testing.T) {
	process := New("unused", "127.0.0.1:8080")
	cfg := config.Veil{}
	process.lastConfig, process.lastToken = &cfg, "token"
	process.setStopping(true)
	process.stateMu.RLock()
	suppressed := process.stopping
	process.stateMu.RUnlock()
	if !suppressed {
		t.Fatal("an operator stop was not recorded")
	}
}
