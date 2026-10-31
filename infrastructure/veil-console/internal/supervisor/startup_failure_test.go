package supervisor

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestCacheCapacityFailureDoesNotScheduleRestart(t *testing.T) {
	if os.Getenv("UMBRATIC_CACHE_FAILURE_CHILD") == "1" {
		os.Exit(1)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestCacheCapacityFailureDoesNotScheduleRestart$")
	cmd.Env = append(os.Environ(), "UMBRATIC_CACHE_FAILURE_CHILD=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	logs := newSafeBuffer(modelLogLimit)
	_, _ = logs.Write([]byte("ValueError: 4.21 GiB KV cache is needed, which is larger than the available KV cache memory (2.39 GiB).\n"))
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := NewModelSupervisor("", "")
	m.processes["test"] = &managedProcess{cmd: cmd, logs: logs, cancel: cancel, exited: make(chan struct{}), status: ModelStatus{State: ModelStarting}}
	m.reap("test", cmd)
	status := m.Status("test")
	if status.State != ModelFailed || status.PID != 0 || !strings.Contains(status.Message, "--max-model-len") {
		t.Fatalf("expected actionable stopped failure: %+v", status)
	}
	if len(m.crashes) != 0 {
		t.Fatal("deterministic failure must not enter restart recovery")
	}
}

func TestNonfatalWarningsDoNotBecomeStartupErrors(t *testing.T) {
	if got := startupFailure("Triton not installed; Class AVFFrameReceiver is implemented in both libraries"); got != "" {
		t.Fatal(got)
	}
}
