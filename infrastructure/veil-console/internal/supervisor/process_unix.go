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
