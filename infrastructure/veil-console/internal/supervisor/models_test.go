package supervisor

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
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
		ID: "qwen3-32b",
		Command: "serve Qwen/Qwen3-32B --host 127.0.0.1 --port 8001 --served-model-name qwen3-32b" +
			" --max-model-len 32768 --gpu-memory-utilization 0.45 --kv-cache-dtype fp8",
	}
}

// withPort rewrites the command's port, which is where a model's port lives.
func withPort(model config.ManagedModel, port int) config.ManagedModel {
	model.Command = strings.Replace(model.Command, "--port 8001", "--port "+strconv.Itoa(port), 1)
	return model
}

// The argv is the entire attack surface of this launcher, so it is asserted
// exactly rather than by substring.
func TestVLLMArgsAreExactAndTyped(t *testing.T) {
	got, err := vllmArgs(managedModel())
	if err != nil {
		t.Fatal(err)
	}
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

// A command is an argument list, so the launcher needs no quoting rules of its
// own — but it must never become a second process. Everything here is refused
// before argv is built.
func TestShellConstructsNeverReachArgv(t *testing.T) {
	base := managedModel().Command
	for name, command := range map[string]string{
		"command chaining":    base + " ; rm -rf /",
		"piping into a shell": base + " | sh",
		"substitution":        base + " --seed $(id -u)",
		"redirection":         base + " > /etc/passwd",
		"flag as model":       "serve --trust-remote-code --port 8001 --served-model-name qwen3-32b",
		"renamed served id":   "serve Qwen/Qwen3-32B --port 8001 --served-model-name other",
	} {
		t.Run(name, func(t *testing.T) {
			model := managedModel()
			model.Command = command
			args, err := vllmArgs(model)
			if err == nil {
				t.Fatalf("this must never reach argv: %#v", args)
			}
			if !strings.Contains(err.Error(), "not allowed") &&
				!strings.Contains(err.Error(), "must start with") &&
				!strings.Contains(err.Error(), "before any flag") &&
				!strings.Contains(err.Error(), "served-model-name") {
				t.Fatalf("refusal did not explain itself: %v", err)
			}
		})
	}
}

func TestChildEnvironmentIsAnAllowlist(t *testing.T) {
	t.Setenv("VEIL_CONSOLE_OWNER_SECRET", "must-not-travel")
	t.Setenv("CUDA_VISIBLE_DEVICES", "0")
	t.Setenv("DO_NOT_TRACK", "0")
	t.Setenv("VLLM_NO_USAGE_STATS", "0")
	t.Setenv("HF_HUB_DISABLE_TELEMETRY", "0")
	values := childEnvironment()
	for _, required := range []string{"DO_NOT_TRACK=1", "VLLM_NO_USAGE_STATS=1", "HF_HUB_DISABLE_TELEMETRY=1", "OTEL_SDK_DISABLED=true"} {
		if !containsPrefix(values, required) {
			t.Fatalf("runtime telemetry must be disabled: %s", required)
		}
	}
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

// The docker wrapper is argv too, so it is asserted exactly: loopback publish,
// container-side rebind to 0.0.0.0, cache mount, and the model as --model.
func TestDockerRunArgsAreExactAndLoopbackPublished(t *testing.T) {
	t.Setenv("HF_TOKEN", "secret-token")
	t.Setenv("VLLM_USE_V2_MODEL_RUNNER", "0")
	// The other forwardable names must be absent for the argv to be exact;
	// t.Setenv registers the restore, then the variable is removed outright.
	for _, name := range []string{"HUGGING_FACE_HUB_TOKEN", "VLLM_WORKER_MULTIPROC_METHOD"} {
		t.Setenv(name, "")
		os.Unsetenv(name)
	}
	folder := t.TempDir()
	model := managedModel()
	model.Command = strings.Replace(model.Command, "Qwen/Qwen3-32B", "\""+folder+"\"", 1)
	got, err := dockerRunArgs("vllm/vllm-openai:v0.28.0", model)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"run", "--rm",
		"--name", "umbratic-model-qwen3-32b",
		"--gpus", "all",
		"--ipc", "host",
		"--mount", "type=bind,src=" + folder + ",dst=" + folder + ",readonly",
		"--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
		"--env", "DO_NOT_TRACK=1", "--env", "VLLM_NO_USAGE_STATS=1",
		"--env", "HF_HUB_DISABLE_TELEMETRY=1", "--env", "OTEL_SDK_DISABLED=true",
		"-p", "127.0.0.1:8001:8001",
		"--env", "VLLM_USE_V2_MODEL_RUNNER",
		"vllm/vllm-openai:v0.28.0",
		"--model", folder,
		"--host", "0.0.0.0",
		"--port", "8001",
		"--served-model-name", "qwen3-32b",
		"--max-model-len", "32768",
		"--gpu-memory-utilization", "0.45",
		"--kv-cache-dtype", "fp8",
	}
	if len(got) != len(want) {
		t.Fatalf("docker argv is %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("docker argv[%d] is %q, want %q", index, got[index], want[index])
		}
	}
	for _, token := range got {
		if strings.Contains(token, "secret-token") {
			t.Fatal("the token value must be passed by name, never in argv")
		}
	}
}

func TestUnconfiguredSupervisorRefusesToStart(t *testing.T) {
	models := NewModelSupervisor("", "")
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
	dir := t.TempDir()
	binary := filepath.Join(dir, "stub-vllm")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate the test file")
	}
	cmd := exec.Command("go", "build", "-o", binary, "./testdata/stub-sleep")
	cmd.Dir = filepath.Dir(thisFile)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build stub runtime: %v\n%s", err, out)
	}
	return binary
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
	models := NewModelSupervisor(binary, "")
	model := managedModel()
	model = withPort(model, freePort(t))
	model.Command = strings.Replace(model.Command, "Qwen/Qwen3-32B", `"`+t.TempDir()+`"`, 1)

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
	models := NewModelSupervisor(binary, "")
	first, second := managedModel(), managedModel()
	first.Command = strings.Replace(first.Command, "0.45", "0.2", 1)
	second.Command = strings.Replace(second.Command, "0.45", "0.2", 1)
	t.Cleanup(models.StopAll)
	first, second = withPort(first, freePort(t)), withPort(second, freePort(t))
	first.Command = strings.Replace(first.Command, "Qwen/Qwen3-32B", `"`+t.TempDir()+`"`, 1)
	second.Command = strings.Replace(second.Command, "Qwen/Qwen3-32B", `"`+t.TempDir()+`"`, 1)
	second.ID = "small"
	second.Command = strings.Replace(second.Command, "--served-model-name qwen3-32b", "--served-model-name small", 1)

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
	model = withPort(model, freePort(t))
	model.Command = strings.Replace(model.Command, "Qwen/Qwen3-32B", `"`+t.TempDir()+`"`, 1)
	listing := map[string]any{"data": []any{map[string]any{"id": model.ID}}}
	payload, _ := json.Marshal(listing)
	server := &http.Server{
		Addr: fmt.Sprintf("127.0.0.1:%d", model.Port()),
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
	models := NewModelSupervisor(binary, "")
	model := managedModel()
	model = withPort(model, freePort(t))
	model.Command = strings.Replace(model.Command, "Qwen/Qwen3-32B", `"`+t.TempDir()+`"`, 1)

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

func TestROCmContainerGetsAMDDevicesWithoutCUDAFlags(t *testing.T) {
	t.Setenv("UMBRATIC_RUNTIME_PROFILE", "rocm")
	model := managedModel()
	model.Command = strings.Replace(model.Command, "Qwen/Qwen3-32B", `"`+t.TempDir()+`"`, 1)
	args, err := dockerRunArgs("reviewed/image@sha256:"+strings.Repeat("a", 64), model)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "--gpus") || !strings.Contains(joined, "--device /dev/kfd") || !strings.Contains(joined, "--device /dev/dri") {
		t.Fatalf("wrong ROCm device contract: %s", joined)
	}
}
