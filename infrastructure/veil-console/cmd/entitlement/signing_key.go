package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Ed25519 seed/private-key base64url needs at most 86 characters; allow a
// small whitespace margin without reading an unbounded existing file.
const maxSigningKeyFileBytes = 4 * 1024

// The release signer is provisioned once and never replaced. It is independent
// of any vendor credential; the deployment administrator owns this key.
func signingKey(path string) ([]byte, bool, error) {
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() {
			return nil, false, errors.New("signing key must be a regular file")
		}
		file, err := os.Open(path)
		if err != nil {
			return nil, false, err
		}
		defer file.Close()
		opened, err := file.Stat()
		if err != nil || !os.SameFile(info, opened) {
			return nil, false, errors.New("signing key changed while opening it")
		}
		if err := validatePrivateSigningKey(file); err != nil {
			return nil, false, err
		}
		data, err := io.ReadAll(io.LimitReader(file, maxSigningKeyFileBytes+1))
		if err != nil {
			return nil, false, err
		}
		if len(data) > maxSigningKeyFileBytes {
			return nil, false, errors.New("signing key file exceeds the 4 KiB size limit")
		}
		return data, false, nil
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
	file, err := createPrivateSigningKey(path)
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
