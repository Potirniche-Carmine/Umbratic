package supervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"umbratic-veil-console/internal/config"
)

// ModelState is what the Models page shows for one runtime.
type ModelState string

const (
	ModelStopped  ModelState = "stopped"
	ModelStarting ModelState = "starting"
	ModelHealthy  ModelState = "healthy"
	ModelFailed   ModelState = "failed"
)

// ModelStatus is a snapshot. `Message` carries the reason a model is failed,
// which is the difference between a page an administrator can act on and one
// that only says something went wrong.
type ModelStatus struct {
	State   ModelState
	PID     int
	Message string
}

// modelStartBudget bounds the health poll. Loading weights onto a GPU takes
// minutes, not seconds, so this is generous by design; the handler never waits
// on it, because a blocking start would time out the browser first.
const modelStartBudget = 10 * time.Minute
const modelPollInterval = 2 * time.Second

// modelLogLimit is per model, so one noisy runtime cannot push another's
// startup error out of the ring.
const modelLogLimit = 32 << 10

type managedProcess struct {
	cmd    *exec.Cmd
	logs   *safeBuffer
	status ModelStatus
	cancel context.CancelFunc
	// exited is closed once Wait returns. Stop waits on it rather than polling
	// cmd.ProcessState: only the reaping goroutine may touch that field, and
	// reading it from here both raced and never observed the exit, so every
	// stop sat out the full kill deadline.
	exited chan struct{}
}

// modelStopDeadline is how long a runtime gets to leave politely. A vLLM
// process holds GPU memory until it is gone, so the deadline is a promise that
// it will be, not a hope.
const modelStopDeadline = 10 * time.Second

// ModelSupervisor launches and supervises one vLLM process per registered
// model. It is deliberately separate from the Veil supervisor: a model
// starting, failing, or being stopped must not disturb the Veil process, whose
// registry is configuration rather than liveness.
type ModelSupervisor struct {
	binary string
	mu     sync.Mutex
	// perModel serializes start and stop for one id, so two clicks cannot race
	// into two processes on one port.
	perModel  map[string]*sync.Mutex
	processes map[string]*managedProcess
}

func NewModelSupervisor(binary string) *ModelSupervisor {
	return &ModelSupervisor{
		binary:    binary,
		perModel:  map[string]*sync.Mutex{},
		processes: map[string]*managedProcess{},
	}
}

// Configured reports whether Console was started with a vLLM binary. Without
// one the Models page renders read-only rather than offering buttons that
// cannot work.
func (m *ModelSupervisor) Configured() bool { return m != nil && m.binary != "" }

// vllmArgs is the entire argument surface. It is a pure function of validated
// typed fields — there is no path by which browser text becomes an argument,
// which is what keeps this a launcher rather than a command runner.
func vllmArgs(model config.ManagedModel) []string {
	return []string{
		"serve", model.ModelPath,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(model.Port),
		"--served-model-name", model.ID,
		"--max-model-len", strconv.Itoa(model.MaxModelLen),
		"--gpu-memory-utilization", strconv.FormatFloat(model.GPUMemoryUtilization, 'f', -1, 64),
		"--kv-cache-dtype", model.KVCacheDType,
	}
}

// childEnvironment is an allowlist, never the parent environment. A GPU runtime
// needs its CUDA and Hugging Face variables and nothing else; inheriting
// wholesale would hand a child every secret Console was started with.
var childEnvironmentAllowlist = []string{
	"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER",
	"CUDA_HOME", "CUDA_VISIBLE_DEVICES", "LD_LIBRARY_PATH", "NVIDIA_VISIBLE_DEVICES",
	"HF_HOME", "HF_HUB_CACHE", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "TRANSFORMERS_CACHE",
	"VLLM_CACHE_ROOT", "VLLM_WORKER_MULTIPROC_METHOD", "TORCH_HOME",
}

func childEnvironment() []string {
	values := make([]string, 0, len(childEnvironmentAllowlist))
	for _, name := range childEnvironmentAllowlist {
		if value, ok := os.LookupEnv(name); ok {
			values = append(values, name+"="+value)
		}
	}
	return values
}

func (m *ModelSupervisor) lockFor(id string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	lock, ok := m.perModel[id]
	if !ok {
		lock = &sync.Mutex{}
		m.perModel[id] = lock
	}
	return lock
}

// Start spawns the runtime and returns immediately. Readiness is reported by a
// background poll, because the load takes minutes and an administrator needs
// the page back now.
func (m *ModelSupervisor) Start(model config.ManagedModel) error {
	if !m.Configured() {
		return errors.New("no vLLM binary is configured")
	}
	if err := model.Validate(); err != nil {
		return err
	}
	lock := m.lockFor(model.ID)
	if !lock.TryLock() {
		return ErrBusy
	}
	defer lock.Unlock()

	m.mu.Lock()
	if existing := m.processes[model.ID]; existing != nil && existing.cmd.Process != nil {
		m.mu.Unlock()
		return errors.New("this model is already running")
	}
	m.mu.Unlock()

	logs := newSafeBuffer(modelLogLimit)
	cmd := exec.Command(m.binary, vllmArgs(model)...)
	configureModelProcess(cmd)
	cmd.Env = childEnvironment()
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		return errors.New("the model runtime did not start")
	}

	ctx, cancel := context.WithCancel(context.Background())
	process := &managedProcess{
		cmd:    cmd,
		logs:   logs,
		status: ModelStatus{State: ModelStarting, PID: cmd.Process.Pid, Message: "loading weights"},
		cancel: cancel,
		exited: make(chan struct{}),
	}
	m.mu.Lock()
	m.processes[model.ID] = process
	m.mu.Unlock()

	go m.reap(model.ID, cmd)
	go m.awaitReady(ctx, model, cmd)
	return nil
}

// reap records the exit. A runtime that dies during load is the common failure
// — a bad path, a model that does not fit — and it must read as failed rather
// than as still starting.
func (m *ModelSupervisor) reap(id string, cmd *exec.Cmd) {
	err := cmd.Wait()
	m.mu.Lock()
	defer m.mu.Unlock()
	process := m.processes[id]
	if process == nil || process.cmd != cmd {
		return
	}
	close(process.exited)
	process.cancel()
	if process.status.State == ModelStopped {
		return
	}
	message := "the model runtime exited"
	state := ModelFailed
	if err == nil {
		message = "stopped"
		state = ModelStopped
	}
	process.status = ModelStatus{State: state, Message: message}
}

// awaitReady flips starting → healthy when the runtime lists its own id.
func (m *ModelSupervisor) awaitReady(ctx context.Context, model config.ManagedModel, cmd *exec.Cmd) {
	deadline := time.After(modelStartBudget)
	ticker := time.NewTicker(modelPollInterval)
	defer ticker.Stop()
	client := &http.Client{Timeout: 3 * time.Second}
	for {
		select {
		case <-ctx.Done():
			return
		case <-deadline:
			m.setStatus(model.ID, cmd, ModelStatus{
				State:   ModelFailed,
				PID:     processID(cmd),
				Message: "the model did not become ready within " + modelStartBudget.String(),
			})
			return
		case <-ticker.C:
			if modelListsItself(ctx, client, model) {
				m.setStatus(model.ID, cmd, ModelStatus{
					State:   ModelHealthy,
					PID:     processID(cmd),
					Message: "serving",
				})
				return
			}
		}
	}
}

func modelListsItself(ctx context.Context, client *http.Client, model config.ManagedModel) bool {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d/v1/models", model.Port), nil)
	if err != nil {
		return false
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		return false
	}
	// The served name is what a chat request must use, so that exact string
	// appearing in the listing is the readiness signal.
	return strings.Contains(string(body), strconv.Quote(model.ID))
}

func processID(cmd *exec.Cmd) int {
	if cmd.Process == nil {
		return 0
	}
	return cmd.Process.Pid
}

func (m *ModelSupervisor) setStatus(id string, cmd *exec.Cmd, status ModelStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	process := m.processes[id]
	if process == nil || process.cmd != cmd {
		return
	}
	process.status = status
}

// Stop asks politely, then kills. A GPU process that outlives Console holds its
// memory, so the deadline is a guarantee rather than a hope.
func (m *ModelSupervisor) Stop(id string) error {
	lock := m.lockFor(id)
	if !lock.TryLock() {
		return ErrBusy
	}
	defer lock.Unlock()
	return m.stopNow(id)
}

func (m *ModelSupervisor) stopNow(id string) error {
	m.mu.Lock()
	process := m.processes[id]
	m.mu.Unlock()
	if process == nil || process.cmd.Process == nil {
		return nil
	}
	process.cancel()
	m.setStatus(id, process.cmd, ModelStatus{State: ModelStopped, Message: "stopped"})
	requestModelProcessStop(process.cmd)
	select {
	case <-process.exited:
		return nil
	case <-time.After(modelStopDeadline):
	}
	// It did not leave on its own. Kill the whole group, then wait for the
	// reaper to confirm, so this returns only once the GPU is actually free.
	killModelProcessGroup(process.cmd)
	select {
	case <-process.exited:
	case <-time.After(5 * time.Second):
	}
	return nil
}

// StopAll runs at Console shutdown. Without it, every supervised runtime
// outlives the console that started it and keeps its share of the GPU.
func (m *ModelSupervisor) StopAll() {
	if m == nil {
		return
	}
	m.mu.Lock()
	ids := make([]string, 0, len(m.processes))
	for id := range m.processes {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	sort.Strings(ids)
	for _, id := range ids {
		_ = m.stopNow(id)
	}
}

func (m *ModelSupervisor) Status(id string) ModelStatus {
	if m == nil {
		return ModelStatus{State: ModelStopped}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	process := m.processes[id]
	if process == nil {
		return ModelStatus{State: ModelStopped}
	}
	return process.status
}

// Logs is the ring-buffer tail, rendered server-side when an administrator
// expands the disclosure. No websocket: a log tail on demand answers the
// question without adding a live channel to a loopback admin page.
func (m *ModelSupervisor) Logs(id string) string {
	if m == nil {
		return ""
	}
	m.mu.Lock()
	process := m.processes[id]
	m.mu.Unlock()
	if process == nil {
		return ""
	}
	return process.logs.String()
}

// RunningCount is the dashboard's "N running / M registered" numerator.
func (m *ModelSupervisor) RunningCount(models []config.ManagedModel) int {
	running := 0
	for _, model := range models {
		switch m.Status(model.ID).State {
		case ModelHealthy, ModelStarting:
			running++
		}
	}
	return running
}
