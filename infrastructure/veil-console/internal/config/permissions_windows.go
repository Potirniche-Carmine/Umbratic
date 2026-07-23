//go:build windows

package config

import "os"

func unsafePermissions(os.FileMode) bool            { return false }
func unsafeOwner(os.FileInfo) bool                  { return false }
func resolveBinaryPath(path string) (string, error) { return path, nil }
