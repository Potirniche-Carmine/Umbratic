package deployment

import (
	"os"
	"path/filepath"
)

// Every supported installer locks the current layout before inspecting either
// installation location. The persistent lock is outside Program, State, and the
// former root, so clean installs, rollback, and archival never move or unlink it.
func acquireInstallationLock(programDir string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(programDir), 0755); err != nil {
		return nil, err
	}
	return acquireDeploymentLock(programDir + ".deploy-lock")
}
