//go:build windows

package supervisor

import "os/exec"

func configureProcess(*exec.Cmd) {}

func requestProcessStop(command *exec.Cmd) {
	_ = command.Process.Kill()
}

// Windows is the development platform; the release target is Ubuntu. There is
// no process-group signal here without a job object, so a model child is killed
// directly and any worker it spawned is left to the operating system.
func configureModelProcess(*exec.Cmd) {}

func requestModelProcessStop(command *exec.Cmd) {
	_ = command.Process.Kill()
}

func killModelProcessGroup(command *exec.Cmd) {
	_ = command.Process.Kill()
}
