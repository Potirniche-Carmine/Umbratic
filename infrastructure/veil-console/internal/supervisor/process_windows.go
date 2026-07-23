//go:build windows

package supervisor

import "os/exec"

func configureProcess(*exec.Cmd) {}

func requestProcessStop(command *exec.Cmd) {
	_ = command.Process.Kill()
}
