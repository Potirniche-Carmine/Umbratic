//go:build !linux && !windows

package supervisor

import (
	"os"
	"os/exec"
	"syscall"
)

func configureProcess(*exec.Cmd) {}

func requestProcessStop(command *exec.Cmd) {
	_ = command.Process.Signal(os.Interrupt)
}

// Same intent as the Linux build: signal the whole tree. Setpgid and a negative
// pid are POSIX, so this is identical there.
func configureModelProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func requestModelProcessStop(command *exec.Cmd) {
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
}

func killModelProcessGroup(command *exec.Cmd) {
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
}
