//go:build !windows

package state

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func unsafePermissions(mode os.FileMode) bool       { return mode.Perm()&0o022 != 0 }
func unsafeSecretPermissions(mode os.FileMode) bool { return mode.Perm()&0o077 != 0 }

func unsafeOwner(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return !ok || stat.Uid != uint32(os.Geteuid())
}

func validateNoSymlinkPath(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return err
	}
	if filepath.Clean(abs) != filepath.Clean(resolved) {
		return errors.New("state directory path must not contain a symlink")
	}
	return nil
}
