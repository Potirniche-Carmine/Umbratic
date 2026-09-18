package deployment

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

const macConsoleDir = "/Library/Application Support/Umbratic/Veil Console"
const formerMacInstallDir = "/opt/umbratic/veil-console"

var installDir = programDirectory(runtime.GOOS)
var stateDir = stateDirectory(runtime.GOOS)

func programDirectory(platform string) string {
	if platform == "darwin" {
		return filepath.Join(macConsoleDir, "Program")
	}
	return "/opt/umbratic/veil-console"
}

func stateDirectory(platform string) string {
	if platform == "darwin" {
		return filepath.Join(macConsoleDir, "State")
	}
	return "/var/lib/veil-console"
}

// The old location is inspected only by the installer for a one-time move.
// Services and runtime code always use the current layout.
func existingProgram() (string, error) {
	former := ""
	if runtime.GOOS == "darwin" {
		former = formerMacInstallDir
	}
	return findExistingProgram(installDir, former)
}

func findExistingProgram(current, former string) (string, error) {
	found := ""
	for _, directory := range []string{current, former} {
		if directory == "" {
			continue
		}
		info, err := os.Lstat(directory)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() {
			return "", fmt.Errorf("installation path is not a directory: %s", directory)
		}
		if found != "" {
			return "", fmt.Errorf("both installation locations exist; resolve the interrupted migration before deploying: %s and %s", current, former)
		}
		found = directory
	}
	return found, nil
}

func backupDirectory(timestamp string) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(macConsoleDir, "Backups", timestamp)
	}
	return installDir + ".backup-" + timestamp
}

// Move the complete former layout, including historical backups and the held
// deployment-lock inode, only after the new services have passed readiness.
func archiveFormerLayout(formerRoot, backup string) error {
	if info, err := os.Lstat(formerRoot); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	} else if !info.IsDir() {
		return fmt.Errorf("former installation root is not a directory: %s", formerRoot)
	}
	destination := filepath.Join(backup, "previous-layout")
	if _, err := os.Lstat(destination); !os.IsNotExist(err) {
		return fmt.Errorf("archive destination already exists or is inaccessible: %s", destination)
	}
	return os.Rename(formerRoot, destination)
}
