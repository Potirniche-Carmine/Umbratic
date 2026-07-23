//go:build windows

package state

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func acquireLock(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open state lock: %w", err)
	}
	var overlapped windows.Overlapped
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	if err := windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, &overlapped); err != nil {
		file.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, errors.New("another Console process owns this state directory")
		}
		return nil, fmt.Errorf("acquire state lock: %w", err)
	}
	if err := file.Truncate(0); err == nil {
		_, _ = file.Seek(0, 0)
		_, _ = fmt.Fprintf(file, "%d\n", os.Getpid())
		_ = file.Sync()
	}
	return file, nil
}

func releaseLock(file *os.File) error {
	var overlapped windows.Overlapped
	unlockErr := windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &overlapped)
	closeErr := file.Close()
	if unlockErr != nil {
		return unlockErr
	}
	if closeErr != nil {
		return closeErr
	}
	return nil
}
