package deployment

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"umbratic-veil-console/internal/modelfolder"
)

func prepareModelsDirectory() error {
	directory := modelfolder.Directory()
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	group := "sudo"
	if runtime.GOOS == "darwin" {
		group = "admin"
		if err := os.Chmod(filepath.Dir(filepath.Dir(directory)), 0755); err != nil {
			return err
		}
		if err := os.Chmod(filepath.Dir(directory), 0755); err != nil {
			return err
		}
	}
	if err := run("chown", serviceUser+":"+group, directory); err != nil {
		return err
	}
	return os.Chmod(directory, os.ModeSetgid|0770)
}

// --clean is explicit: all Umbratic Console state and registered models are
// removed. The deployment package and unrelated Umbratic desktop files remain.
func removeInstallation() error {
	if os.Geteuid() != 0 {
		return errors.New("run sudo ./deploy.sh --clean")
	}
	if err := stopServices(); err != nil {
		return err
	}
	for _, name := range services {
		if err := os.Remove(servicePath(name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	paths := []string{installDir, stateDir, modelfolder.Directory()}
	if runtime.GOOS == "linux" {
		paths = append(paths, "/usr/local/share/applications/umbratic-models.desktop")
	}
	if runtime.GOOS == "darwin" {
		paths = append(paths, formerMacInstallDir, "/private/var/lib/veil-console")
	}
	for _, p := range paths {
		if err := os.RemoveAll(p); err != nil {
			return err
		}
	}
	return nil
}
