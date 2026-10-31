//go:build !windows

package main

import (
	"errors"
	"os"
)

func createPrivateSigningKey(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
}

func validatePrivateSigningKey(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Mode().Perm() != 0600 {
		return errors.New("signing key must have owner-only read/write permissions")
	}
	return nil
}
