//go:build linux

package supervisor

import (
	"os"
	"os/exec"
	"syscall"
)

func configureProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}

func requestProcessStop(command *exec.Cmd) {
	_ = command.Process.Signal(os.Interrupt)
}

// A model runtime is a process tree, not a process: vLLM spawns workers that
// inherit its stdout pipe. Signalling the leader alone leaves the workers
// holding both the pipe — so cmd.Wait never returns — and the GPU memory. The
// child leads its own process group so the whole tree can be signalled at once.
func configureModelProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM, Setpgid: true}
}

func requestModelProcessStop(command *exec.Cmd) {
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
}

func killModelProcessGroup(command *exec.Cmd) {
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
}
