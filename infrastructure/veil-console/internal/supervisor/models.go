package supervisor

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
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
	allocation float64
	cmd        *exec.Cmd
	logs       *safeBuffer
	// command is what this process was actually launched with, so the page can
	// say when the saved command has moved on from the running one.
	command string
	status  ModelStatus
	cancel  context.CancelFunc
	// model is what this process was launched from, so an unexpected exit can
	// be restarted from the same definition without consulting the store.
	model config.ManagedModel
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
	binary   string
	closing  bool
	launchMu sync.Mutex
	// dockerImage switches launches to `docker run` of this vLLM OpenAI-server
	// image. The card command is still the single source of truth: Console
	// derives the container flags from it rather than storing them twice.
	dockerImage string
	mu          sync.Mutex
	// perModel serializes start and stop for one id, so two clicks cannot race
	// into two processes on one port.
	perModel  map[string]*sync.Mutex
	processes map[string]*managedProcess
	// crashes holds recent unexpected exits per model id, surviving the process
	// that produced them so the circuit breaker sees the loop rather than one
	// exit at a time.
	crashes map[string][]time.Time
}

func NewModelSupervisor(binary, dockerImage string) *ModelSupervisor {
	return &ModelSupervisor{
		binary:      binary,
		dockerImage: dockerImage,
		perModel:    map[string]*sync.Mutex{},
		processes:   map[string]*managedProcess{},
		crashes:     map[string][]time.Time{},
	}
}

// Configured reports whether Console was started with a way to launch models —
// a vLLM binary or a vLLM Docker image. Without either the Models page renders
// read-only rather than offering buttons that cannot work.
func (m *ModelSupervisor) Configured() bool {
	return m != nil && (m.binary != "" || m.dockerImage != "")
}

// vllmArgs is the entire argument surface. The command is parsed and validated
// into a token list here and executed directly — no shell is involved, so no
// metacharacter has any meaning, and a command that does not parse never
// reaches exec at all.
func vllmArgs(model config.ManagedModel) ([]string, error) {
	facts, err := model.Parse()
	if err != nil {
		return nil, err
	}
	args := facts.Args
	hasHost := false
	// Runtime listeners are private even when Advanced supplies a host flag.
	for i := 0; i < len(args); i++ {
		if args[i] == "--host" && i+1 < len(args) {
			args[i+1] = "127.0.0.1"
			hasHost = true
			i++
		} else if strings.HasPrefix(args[i], "--host=") {
			args[i] = "--host=127.0.0.1"
			hasHost = true
		}
	}
	if !hasHost {
		args = append(args, "--host", "127.0.0.1")
	}
	return args, nil
}

// containerName is the deterministic docker name for one model, so a stale
// container from a hard kill can be removed before the next start claims the
// port. Served ids are already limited to [A-Za-z0-9._-], which docker accepts.
func containerName(id string) string { return "umbratic-model-" + id }

// dockerRunArgs wraps the card's own argument list into a docker run of the
// vLLM OpenAI-server image. The transformation is small and mechanical:
//
//   - the container binds 0.0.0.0 so the published port can reach it, and the
//     publish flag pins the host side to 127.0.0.1, so exposure is loopback
//     exactly as it is with a host binary;
//   - the positional model after `serve` becomes --model, which is what the
//     image's entrypoint takes;
//   - the selected local folder is mounted read-only at the same path;
//   - offline mode blocks model downloads and no Hub tokens are passed.
func dockerRunArgs(image string, model config.ManagedModel) ([]string, error) {
	facts, err := model.Parse()
	if err != nil {
		return nil, err
	}
	// facts.Args is ["serve", "<model>", flags...]; Parse guarantees the shape.
	flags := append([]string(nil), facts.Args[2:]...)
	hostRewritten := false
	for index := 0; index < len(flags); index++ {
		if flags[index] == "--host" && index+1 < len(flags) {
			flags[index+1] = "0.0.0.0"
			hostRewritten = true
		}
		if strings.HasPrefix(flags[index], "--host=") {
			flags[index] = "--host=0.0.0.0"
			hostRewritten = true
		}
	}
	if !hostRewritten {
		flags = append(flags, "--host", "0.0.0.0")
	}
	if !filepath.IsAbs(facts.ModelPath) {
		return nil, errors.New("select a local model folder; downloads are disabled")
	}
	var mount strings.Builder
	writer := csv.NewWriter(&mount)
	if err := writer.Write([]string{"type=bind", "src=" + facts.ModelPath, "dst=" + facts.ModelPath, "readonly"}); err != nil {
		return nil, err
	}
	writer.Flush()
	args := []string{
		"run", "--rm",
		"--name", containerName(model.ID),
		"--ipc", "host",
		"--mount", strings.TrimSuffix(mount.String(), "\n"),
		"--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
		"--env", "DO_NOT_TRACK=1", "--env", "VLLM_NO_USAGE_STATS=1",
		"--env", "HF_HUB_DISABLE_TELEMETRY=1", "--env", "OTEL_SDK_DISABLED=true",
		"-p", fmt.Sprintf("127.0.0.1:%d:%d", facts.Port, facts.Port),
	}
	switch os.Getenv("UMBRATIC_RUNTIME_PROFILE") {
	case "rocm", "rocm-integrated":
		args = append(args, "--device", "/dev/kfd", "--device", "/dev/dri", "--group-add", "video", "--group-add", "render")
	case "rocm-wsl":
		args = append(args, "--device", "/dev/dxg", "--mount", "type=bind,src=/usr/lib/wsl,dst=/usr/lib/wsl,readonly")
	case "", "cuda":
		// Retain placement before IPC for a stable, inspectable launch contract.
		args = append(args[:4], append([]string{"--gpus", "all"}, args[4:]...)...)
	default:
		return nil, errors.New("unsupported container runtime profile")
	}
	// Passed by name, so the docker client reads each value from its own
	// environment and no secret or setting lands in argv. The vLLM knobs let a
	// deployment adapt the runtime to its host — WSL, for one, has no UVA and
	// needs VLLM_USE_V2_MODEL_RUNNER=0 — without baking that host's quirk in.
	for _, name := range []string{
		"VLLM_USE_V2_MODEL_RUNNER", "VLLM_WORKER_MULTIPROC_METHOD",
	} {
		if _, ok := os.LookupEnv(name); ok {
			args = append(args, "--env", name)
		}
	}
	args = append(args, image, "--model", facts.ModelPath)
	return append(args, flags...), nil
}

// removeStaleContainer clears a container a hard-killed docker client left
// behind. Best effort: when there is nothing to remove, docker says so and the
// next start proceeds.
func removeStaleContainer(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "rm", "--force", containerName(id))
	cmd.Env = childEnvironment()
	_ = cmd.Run()
}

// childEnvironment is an allowlist, never the parent environment. A GPU runtime
// needs its CUDA and Hugging Face variables and nothing else; inheriting
// wholesale would hand a child every secret Console was started with.
var childEnvironmentAllowlist = []string{
	"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "USER", "XDG_CACHE_HOME",
	"CUDA_HOME", "CUDA_VISIBLE_DEVICES", "LD_LIBRARY_PATH", "NVIDIA_VISIBLE_DEVICES",
	"HF_HOME", "HF_HUB_CACHE", "TRANSFORMERS_CACHE",
	"VLLM_CACHE_ROOT", "VLLM_WORKER_MULTIPROC_METHOD", "VLLM_USE_V2_MODEL_RUNNER", "TORCH_HOME",
}

func childEnvironment() []string {
	values := make([]string, 0, len(childEnvironmentAllowlist))
	for _, name := range childEnvironmentAllowlist {
		if value, ok := os.LookupEnv(name); ok {
			values = append(values, name+"="+value)
		}
	}
	return append(values, "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1",
		"DO_NOT_TRACK=1", "VLLM_NO_USAGE_STATS=1", "HF_HUB_DISABLE_TELEMETRY=1", "OTEL_SDK_DISABLED=true")
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
		return errors.New("no vLLM binary or Docker image is configured")
	}
	if err := model.Validate(); err != nil {
		return err
	}
	facts, err := model.Parse()
	if err != nil {
		return err
	}
	if !filepath.IsAbs(facts.ModelPath) {
		return errors.New("select a local model folder; downloads are disabled")
	}
	info, err := os.Stat(facts.ModelPath)
	if err != nil || !info.IsDir() {
		return errors.New("the local model folder is missing or cannot be read")
	}

	lock := m.lockFor(model.ID)
	if !lock.TryLock() {
		return ErrBusy
	}
	defer lock.Unlock()
	m.launchMu.Lock()
	defer m.launchMu.Unlock()

	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return errors.New("Console is shutting down")
	}
	if existing := m.processes[model.ID]; existing != nil && existing.cmd.Process != nil {
		select {
		case <-existing.exited:
		default:
			m.mu.Unlock()
			return errors.New("this model is already running")
		}
	}
	m.mu.Unlock()

	launchModel, allocation, err := m.allocation(model)
	if err != nil {
		return err
	}
	var cmd *exec.Cmd
	if m.dockerImage != "" {
		args, err := dockerRunArgs(m.dockerImage, launchModel)
		if err != nil {
			return err
		}
		// A previous hard kill can leave a named container holding the port.
		removeStaleContainer(model.ID)
		cmd = exec.Command("docker", args...)
	} else {
		args, err := vllmArgs(launchModel)
		if err != nil {
			return err
		}
		cmd = exec.Command(m.binary, args...)
	}
	logs := newSafeBuffer(modelLogLimit)
	configureModelProcess(cmd)
	cmd.Env = childEnvironment()
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		return errors.New("the model runtime did not start")
	}

	ctx, cancel := context.WithCancel(context.Background())
	process := &managedProcess{
		allocation: allocation,
		cmd:        cmd,
		logs:       logs,
		command:    strings.TrimSpace(model.Command),
		model:      model,
		status:     ModelStatus{State: ModelStarting, PID: cmd.Process.Pid, Message: "Starting model"},
		cancel:     cancel,
		exited:     make(chan struct{}),
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
	process := m.processes[id]
	if process == nil || process.cmd != cmd {
		m.mu.Unlock()
		return
	}
	close(process.exited)
	process.cancel()
	if process.status.State == ModelStopped {
		m.mu.Unlock()
		return
	}
	message := "Exited unexpectedly"
	state := ModelFailed
	if err == nil {
		message = "Stopped"
		state = ModelStopped
	}
	recoverable := state == ModelFailed
	if hint := startupFailure(process.logs.String()); recoverable && hint != "" {
		message = hint
		recoverable = false
	}
	process.status = ModelStatus{State: state, Message: message}
	model := process.model
	m.mu.Unlock()
	if recoverable {
		go m.recoverModel(model)
	}
}

// recoverModel restarts a runtime that exited on its own. A model that dies on
// every start — bad weights path, not enough GPU memory — trips the same crash
// window the Veil supervisor uses and is then left down for an administrator,
// because restarting it forever would only keep the GPU busy failing.
func (m *ModelSupervisor) recoverModel(model config.ManagedModel) {
	m.mu.Lock()
	now := time.Now()
	live := m.crashes[model.ID][:0]
	for _, at := range m.crashes[model.ID] {
		if now.Sub(at) < restartWindow {
			live = append(live, at)
		}
	}
	m.crashes[model.ID] = append(live, now)
	attempts := len(m.crashes[model.ID])
	m.mu.Unlock()

	if attempts > maxRestartsInWindow {
		m.noteModel(model.ID, "Exited repeatedly. Automatic restart is paused — check the log, then start it from this page.")
		return
	}
	delay := restartBackoffBase * time.Duration(1<<(attempts-1))
	if delay > restartBackoffMax {
		delay = restartBackoffMax
	}
	m.noteModel(model.ID, fmt.Sprintf("Exited unexpectedly. Restarting in %s.", delay.Round(time.Second)))
	time.Sleep(delay)

	m.mu.Lock()
	process := m.processes[model.ID]
	stopped := process == nil || process.status.State == ModelStopped
	m.mu.Unlock()
	// An administrator stopped or restarted it while the delay ran; their
	// intent wins over the recovery that was already scheduled.
	if stopped {
		return
	}
	if err := m.Start(model); err != nil && !errors.Is(err, ErrBusy) {
		m.noteModel(model.ID, "Exited unexpectedly and did not restart.")
	}
}

func (m *ModelSupervisor) noteModel(id, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if process := m.processes[id]; process != nil && process.status.State == ModelFailed {
		process.status.Message = message
	}
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
				if err := probeModelRole(ctx, model); err != nil {
					m.setStatus(model.ID, cmd, ModelStatus{State: ModelFailed, PID: processID(cmd), Message: err.Error()})
					return
				}
				m.setStatus(model.ID, cmd, ModelStatus{
					State:   ModelHealthy,
					PID:     processID(cmd),
					Message: "Serving",
				})
				return
			}
		}
	}
}

func modelListsItself(ctx context.Context, client *http.Client, model config.ManagedModel) bool {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d/v1/models", model.Port()), nil)
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
	var listing struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &listing) != nil {
		return false
	}
	for _, entry := range listing.Data {
		if entry.ID == model.ID {
			return true
		}
	}
	return false
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
	m.setStatus(id, process.cmd, ModelStatus{State: ModelStopped, Message: "Stopped"})
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
	// Killing the docker client leaves the container itself running; the
	// daemon has to be told, or the GPU and the port stay claimed.
	if m.dockerImage != "" {
		removeStaleContainer(id)
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
	m.closing = true
	ids := make([]string, 0, len(m.processes))
	for id := range m.perModel {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	sort.Strings(ids)
	for _, id := range ids {
		lock := m.lockFor(id)
		lock.Lock()
		_ = m.stopNow(id)
		lock.Unlock()
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
// RunningCommand is the command the live process was launched with, empty when
// nothing is running. The page compares it with the saved one.
func (m *ModelSupervisor) RunningCommand(id string) string {
	if m == nil {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	process := m.processes[id]
	if process == nil {
		return ""
	}
	switch process.status.State {
	case ModelHealthy, ModelStarting:
		return process.command
	}
	return ""
}

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
