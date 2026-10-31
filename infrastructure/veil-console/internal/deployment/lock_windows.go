//go:build windows

package deployment

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func acquireDeploymentLock(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, fmt.Errorf("deployment lock path: %w", err)
	}
	// macOS-layout migration moves the held lock with its directory. Sharing
	// deletion permits that rename without releasing the kernel byte-range lock.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, fmt.Errorf("open deployment lock: %w", err)
	}
	file := os.NewFile(uintptr(handle), path)
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
