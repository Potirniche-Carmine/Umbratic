//go:build windows

package deployment

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func acquireDeploymentLock(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open deployment lock: %w", err)
	}
	var overlapped windows.Overlapped
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	if err := windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, &overlapped); err != nil {
		file.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, errors.New("another deployment is running")
		}
		return nil, fmt.Errorf("acquire deployment lock: %w", err)
	}
	// The OS releases the lock when this descriptor closes or its process exits.
	return file, nil
}
