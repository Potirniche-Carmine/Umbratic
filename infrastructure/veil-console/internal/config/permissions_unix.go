//go:build !windows

package config

import (
	"os"
	"path/filepath"
	"syscall"
)

func unsafePermissions(mode os.FileMode) bool { return mode.Perm()&0o022 != 0 }

func resolveBinaryPath(path string) (string, error) { return filepath.EvalSymlinks(path) }

func unsafeOwner(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return !ok || (stat.Uid != 0 && stat.Uid != uint32(os.Geteuid()))
}
