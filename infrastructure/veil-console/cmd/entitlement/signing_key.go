package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
)

// The release signer is provisioned once and never replaced. It is independent
// of the feed master; customer update keys keep their existing derivation.
func signingKey(path string) ([]byte, bool, error) {
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() {
			return nil, false, errors.New("signing key must be a regular file")
		}
		data, err := os.ReadFile(path)
		return data, false, err
	}
	if !os.IsNotExist(err) {
		return nil, false, err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, false, err
	}
	data := []byte(base64.RawURLEncoding.EncodeToString(seed))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, false, err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, false, err
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		return nil, false, writeErr
	}
	if closeErr != nil {
		return nil, false, closeErr
	}
	return data, true, nil
}
