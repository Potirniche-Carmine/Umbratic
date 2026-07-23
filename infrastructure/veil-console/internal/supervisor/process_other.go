//go:build !linux && !windows

package supervisor

import (
	"os"
	"os/exec"
)

func configureProcess(*exec.Cmd) {}

func requestProcessStop(command *exec.Cmd) {
	_ = command.Process.Signal(os.Interrupt)
}
