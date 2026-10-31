//go:build !windows

package deployment

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func acquireDeploymentLock(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open deployment lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, errors.New("another deployment is running")
		}
		return nil, fmt.Errorf("acquire deployment lock: %w", err)
	}
	// Closing the descriptor or exiting releases the lock, including after a
	// crash. Never unlink the file: another process could lock a new inode.
	return file, nil
}
