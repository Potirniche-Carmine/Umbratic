package entitlement

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// TrustedPublicKey is set in customer release binaries with -ldflags.
var TrustedPublicKey string

type Payload struct {
	Version            int    `json:"version"`
	OrgUID             string `json:"org_uid"`
	MaxAuthorizedUsers int    `json:"max_authorized_users"`
	MaxDevicesPerUser  int    `json:"max_devices_per_user"`
	TermStartsAt       string `json:"term_starts_at,omitempty"`
	TermEndsAt         string `json:"term_ends_at,omitempty"`
}

type Document struct {
	Payload   Payload `json:"payload"`
	Signature string  `json:"signature"`
}

func Load(path string, now time.Time) (Payload, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Payload{}, fmt.Errorf("read entitlement: %w", err)
	}
	return Verify(data, TrustedPublicKey, now)
}

func Verify(data []byte, publicKeyText string, now time.Time) (Payload, error) {
	var document Document
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil {
		return Payload{}, errors.New("entitlement document is invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Payload{}, errors.New("entitlement document is invalid")
	}
	if err := validatePayload(document.Payload, now); err != nil {
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
	payload, _ := json.Marshal(document.Payload)
	if !ed25519.Verify(ed25519.PublicKey(publicKey), payload, signature) {
		return Payload{}, errors.New("entitlement signature verification failed")
	}
	return document.Payload, nil
}

func Sign(payload Payload, privateKeyText string) ([]byte, string, error) {
	if err := validatePayload(payload, time.Time{}); err != nil {
		return nil, "", err
	}
	privateKey, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(privateKeyText))
	if err != nil {
		return nil, "", errors.New("entitlement signing key is invalid")
	}
	if len(privateKey) == ed25519.SeedSize {
		privateKey = ed25519.NewKeyFromSeed(privateKey)
	}
	if len(privateKey) != ed25519.PrivateKeySize {
		return nil, "", errors.New("entitlement signing key is invalid")
	}
	payloadJSON, _ := json.Marshal(payload)
	signature := ed25519.Sign(ed25519.PrivateKey(privateKey), payloadJSON)
	document, err := json.MarshalIndent(Document{
		Payload: payload, Signature: base64.RawURLEncoding.EncodeToString(signature),
	}, "", "  ")
	publicKey := ed25519.PrivateKey(privateKey).Public().(ed25519.PublicKey)
	return append(document, '\n'), base64.RawURLEncoding.EncodeToString(publicKey), err
}

func NewOrgUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return "org_" + base64.RawURLEncoding.EncodeToString(value), nil
}

func validatePayload(payload Payload, now time.Time) error {
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
	if payload.TermStartsAt != "" {
		start, err := time.Parse(time.RFC3339, payload.TermStartsAt)
		if err != nil || (!now.IsZero() && now.Before(start)) {
			return errors.New("entitlement term has not started")
		}
	}
	if payload.TermEndsAt != "" {
		end, err := time.Parse(time.RFC3339, payload.TermEndsAt)
		if err != nil || (!now.IsZero() && !now.Before(end)) {
			return errors.New("entitlement term has ended")
		}
	}
	return nil
}
