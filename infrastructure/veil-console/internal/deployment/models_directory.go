package deployment

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

const macModelsDir = "/Library/Application Support/Umbratic/Veil Console/Models"

func prepareModelsDirectory() error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	if err := os.MkdirAll(macModelsDir, 0755); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Dir(filepath.Dir(macModelsDir)), 0755); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Dir(macModelsDir), 0755); err != nil {
		return err
	}
	if err := run("chown", serviceUser+":admin", macModelsDir); err != nil {
		return err
	}
	return os.Chmod(macModelsDir, os.ModeSetgid|0770)
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
	paths := []string{installDir, stateDir}
	if runtime.GOOS == "darwin" {
		paths = append(paths, filepath.Dir(macModelsDir), "/private/var/lib/veil-console")
	}
	for _, p := range paths {
		if err := os.RemoveAll(p); err != nil {
			return err
		}
	}
	return nil
}
