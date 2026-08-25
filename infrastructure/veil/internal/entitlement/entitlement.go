package entitlement

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// TrustedPublicKey is set in customer release binaries with -ldflags.
// It must contain one base64url-encoded Ed25519 public key.
var TrustedPublicKey string

type Payload struct {
	Version            int    `json:"version"`
	OrgUID             string `json:"org_uid"`
	MaxAuthorizedUsers int    `json:"max_authorized_users"`
	MaxDevicesPerUser  int    `json:"max_devices_per_user"`
	// MaxSearchesPerMonth is the whole organization's monthly web-search pool,
	// not a per-seat rate: a sales team searches far more than an engineering
	// one, and pooling is the point. Zero is the default and means this
	// organization did not buy web search.
	//
	// omitempty is load-bearing rather than tidy. The signature covers
	// json.Marshal of this struct, so every document signed before the field
	// existed has to keep marshaling byte identically or it stops verifying.
	MaxSearchesPerMonth int `json:"max_searches_per_month,omitempty"`
}

type Document struct {
	Payload   Payload `json:"payload"`
	Signature string  `json:"signature"`
}

func Load(path string) (Payload, error) {
	if strings.TrimSpace(path) == "" {
		return Payload{}, errors.New("entitlement path is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Payload{}, fmt.Errorf("read entitlement: %w", err)
	}
	return Verify(data, TrustedPublicKey)
}

func Verify(data []byte, publicKeyText string) (Payload, error) {
	var document Document
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return Payload{}, errors.New("entitlement document is invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Payload{}, errors.New("entitlement document is invalid")
	}
	if err := validatePayload(document.Payload); err != nil {
		return Payload{}, err
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(publicKeyText))
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return Payload{}, errors.New("trusted entitlement public key is invalid")
	}
	signature, err := base64.RawURLEncoding.DecodeString(document.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return Payload{}, errors.New("entitlement signature is invalid")
	}
	payload, err := json.Marshal(document.Payload)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(publicKey), payload, signature) {
		return Payload{}, errors.New("entitlement signature verification failed")
	}
	return document.Payload, nil
}

func validatePayload(payload Payload) error {
	if payload.Version != 1 {
		return errors.New("entitlement version is not supported")
	}
	if !strings.HasPrefix(payload.OrgUID, "org_") || len(payload.OrgUID) < 12 || len(payload.OrgUID) > 80 {
		return errors.New("entitlement organization UID is invalid")
	}
	if payload.MaxAuthorizedUsers < 1 || payload.MaxAuthorizedUsers > 1_000_000 {
		return errors.New("entitlement seat limit is invalid")
	}
	if payload.MaxDevicesPerUser < 1 || payload.MaxDevicesPerUser > 32 {
		return errors.New("entitlement device limit is invalid")
	}
	// Zero is valid here, unlike the seat and device limits: an organization
	// that bought no web search is the common case, not a malformed document.
	if payload.MaxSearchesPerMonth < 0 || payload.MaxSearchesPerMonth > 100_000_000 {
		return errors.New("entitlement monthly search limit is invalid")
	}
	return nil
}
