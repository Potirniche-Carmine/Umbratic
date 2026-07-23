//go:build windows

package state

import "os"

func unsafePermissions(os.FileMode) bool       { return false }
func unsafeSecretPermissions(os.FileMode) bool { return false }
func unsafeOwner(os.FileInfo) bool             { return false }
func validateNoSymlinkPath(string) error       { return nil }
