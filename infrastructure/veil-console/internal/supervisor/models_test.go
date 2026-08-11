package supervisor

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"umbratic-veil-console/internal/config"
)

func managedModel() config.ManagedModel {
	return config.ManagedModel{
		ID: "qwen3-32b", DisplayName: "Qwen 32B", ModelPath: "Qwen/Qwen3-32B",
		Port: 8001, MaxModelLen: 32768, GPUMemoryUtilization: 0.45, KVCacheDType: config.KVCacheFP8,
	}
}

// The argv is the entire attack surface of this launcher, so it is asserted
// exactly rather than by substring.
func TestVLLMArgsAreExactAndTyped(t *testing.T) {
	got := vllmArgs(managedModel())
	want := []string{
		"serve", "Qwen/Qwen3-32B",
		"--host", "127.0.0.1",
		"--port", "8001",
		"--served-model-name", "qwen3-32b",
		"--max-model-len", "32768",
		"--gpu-memory-utilization", "0.45",
		"--kv-cache-dtype", "fp8",
	}
	if len(got) != len(want) {
		t.Fatalf("argv shape changed: %#v", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("argv[%d] = %q, want %q", index, got[index], want[index])
		}
	}
}

// Every one of these is refused by Validate before argv is ever built, which is
// why the launcher needs no quoting rules of its own.
func TestInjectionAttemptsNeverReachArgv(t *testing.T) {
	for name, mutate := range map[string]func(*config.ManagedModel){
		"flag as id":            func(m *config.ManagedModel) { m.ID = "--tensor-parallel-size" },
		"flag as model path":    func(m *config.ManagedModel) { m.ModelPath = "--trust-remote-code" },
		"whitespace in id":      func(m *config.ManagedModel) { m.ID = "a b" },
		"newline in model path": func(m *config.ManagedModel) { m.ModelPath = "model\n--trust-remote-code" },
		"null in model path":    func(m *config.ManagedModel) { m.ModelPath = "model\x00evil" },
		"dtype smuggling":       func(m *config.ManagedModel) { m.KVCacheDType = "fp8 --trust-remote-code" },
	} {
		t.Run(name, func(t *testing.T) {
			model := managedModel()
			mutate(&model)
			if err := model.Validate(); err == nil {
				t.Fatalf("this value must never reach argv: %#v", vllmArgs(model))
			}
		})
	}
}

func TestChildEnvironmentIsAnAllowlist(t *testing.T) {
	t.Setenv("VEIL_CONSOLE_OWNER_SECRET", "must-not-travel")
	t.Setenv("CUDA_VISIBLE_DEVICES", "0")
	values := childEnvironment()
	for _, value := range values {
		if strings.HasPrefix(value, "VEIL_CONSOLE_OWNER_SECRET=") {
			t.Fatal("the child must not inherit Console's environment")
		}
	}
	if !containsPrefix(values, "CUDA_VISIBLE_DEVICES=") {
		t.Fatalf("an allowlisted GPU variable must travel: %#v", values)
	}
}

func containsPrefix(values []string, prefix string) bool {
	for _, value := range values {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}

func TestUnconfiguredSupervisorRefusesToStart(t *testing.T) {
	models := NewModelSupervisor("")
	if models.Configured() {
		t.Fatal("no binary means not configured")
	}
	if err := models.Start(managedModel()); err == nil {
		t.Fatal("starting without a vLLM binary must fail loudly")
	}
	if got := models.Status("qwen3-32b").State; got != ModelStopped {
		t.Fatalf("an unstarted model reads as stopped, got %q", got)
	}
}

// stubRuntime stands in for vLLM: a script that serves /v1/models on the port
// it was told to use, which is the exact signal awaitReady polls for.
func writeStubRuntime(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stub runtime is a POSIX shell script")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "stub-vllm")
	// A long-lived process that never serves: enough to assert spawn, status,
	// double-start refusal, and reaping, without a GPU anywhere in sight.
	script := "#!/bin/sh\necho \"stub runtime: $*\"\nsleep 3600\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

// The lifecycle assertion that does not need a real runtime: a process that
// starts and never serves must reach starting, and Stop must reap it.
func TestStartAndStopLifecycleWithAStubBinary(t *testing.T) {
	binary := writeStubRuntime(t)
	models := NewModelSupervisor(binary)
	model := managedModel()
	model.Port = freePort(t)

	if err := models.Start(model); err != nil {
		t.Fatal(err)
	}
	status := models.Status(model.ID)
	if status.State != ModelStarting {
		t.Fatalf("a freshly spawned runtime is starting, got %q", status.State)
	}
	if status.PID == 0 {
		t.Fatal("a running child must report its PID")
	}
	if err := models.Start(model); err == nil {
		t.Fatal("starting a running model twice must be refused")
	}

	if err := models.Stop(model.ID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if models.Status(model.ID).State == ModelStopped {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("Stop must reap the child, state is %q", models.Status(model.ID).State)
}

func TestStopAllReapsEveryChild(t *testing.T) {
	binary := writeStubRuntime(t)
	models := NewModelSupervisor(binary)
	first, second := managedModel(), managedModel()
	first.Port, second.Port = freePort(t), freePort(t)
	second.ID = "small"

	if err := models.Start(first); err != nil {
		t.Fatal(err)
	}
	if err := models.Start(second); err != nil {
		t.Fatal(err)
	}
	if got := models.RunningCount([]config.ManagedModel{first, second}); got != 2 {
		t.Fatalf("both children count as running, got %d", got)
	}
	models.StopAll()
	for _, model := range []config.ManagedModel{first, second} {
		if got := models.Status(model.ID).State; got != ModelStopped {
			t.Fatalf("%s must be stopped after StopAll, got %q", model.ID, got)
		}
	}
}

// awaitReady's readiness signal, tested against a listener rather than a
// process: the served name appearing in /v1/models is what flips healthy.
func TestReadinessRequiresTheServedNameInTheListing(t *testing.T) {
	model := managedModel()
	model.Port = freePort(t)
	listing := map[string]any{"data": []any{map[string]any{"id": model.ID}}}
	payload, _ := json.Marshal(listing)
	server := &http.Server{
		Addr: fmt.Sprintf("127.0.0.1:%d", model.Port),
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/models" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(payload)
		}),
	}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()

	client := &http.Client{Timeout: time.Second}
	if !modelListsItself(t.Context(), client, model) {
		t.Fatal("a runtime listing its served name is ready")
	}

	other := model
	other.ID = "not-served-here"
	if modelListsItself(t.Context(), client, other) {
		t.Fatal("a runtime serving a different name is not this model")
	}
}

// writeTreeRuntime spawns a grandchild that outlives its parent and inherits
// the stdout pipe — exactly what a real vLLM does with its workers.
func writeTreeRuntime(t *testing.T) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stub runtime is a POSIX shell script")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "worker.pid")
	path := filepath.Join(dir, "tree-vllm")
	script := "#!/bin/sh\n" +
		"sleep 3600 &\n" +
		"echo $! > " + marker + "\n" +
		"echo \"tree runtime: $*\"\n" +
		"wait\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path, marker
}

// A model runtime is a process tree. Signalling only the leader left the
// workers holding the stdout pipe, so cmd.Wait never returned and every stop
// sat out the full kill deadline while the GPU stayed occupied.
func TestStoppingAModelReapsItsWholeProcessTree(t *testing.T) {
	binary, marker := writeTreeRuntime(t)
	models := NewModelSupervisor(binary)
	model := managedModel()
	model.Port = freePort(t)

	if err := models.Start(model); err != nil {
		t.Fatal(err)
	}
	var workerPID int
	for attempt := 0; attempt < 50; attempt++ {
		payload, err := os.ReadFile(marker)
		if err == nil {
			workerPID, _ = strconv.Atoi(strings.TrimSpace(string(payload)))
		}
		if workerPID > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if workerPID == 0 {
		t.Fatal("the stub runtime never reported a worker pid")
	}

	started := time.Now()
	if err := models.Stop(model.ID); err != nil {
		t.Fatal(err)
	}
	// Prompt: the administrator clicked Stop and the page is waiting on this.
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("stop took %s; it is waiting out the kill deadline rather than observing the exit", elapsed)
	}
	if got := models.Status(model.ID).State; got != ModelStopped {
		t.Fatalf("the model must read as stopped, got %q", got)
	}
	// And the worker is gone with it, rather than left holding the GPU.
	for attempt := 0; attempt < 40; attempt++ {
		if !processAlive(workerPID) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("worker %d outlived the model it belonged to", workerPID)
}

func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}
