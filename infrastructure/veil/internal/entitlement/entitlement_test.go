package entitlement

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func signedDocument(t *testing.T, payload Payload) ([]byte, string) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	canonical, _ := json.Marshal(payload)
	document, _ := json.Marshal(Document{
		Payload:   payload,
		Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, canonical)),
	})
	return document, base64.RawURLEncoding.EncodeToString(publicKey)
}

func TestVerifyRejectsChangedSeatAndDeviceLimits(t *testing.T) {
	payload := Payload{
		Version: 1, OrgUID: "org_abcdefghijklmnop",
		MaxAuthorizedUsers: 2, MaxDevicesPerUser: 2,
	}
	document, publicKey := signedDocument(t, payload)
	verified, err := Verify(document, publicKey)
	if err != nil || verified.MaxAuthorizedUsers != 2 || verified.MaxDevicesPerUser != 2 {
		t.Fatalf("valid entitlement failed: %#v %v", verified, err)
	}
	for _, changed := range []string{
		strings.Replace(string(document), `"max_authorized_users":2`, `"max_authorized_users":3`, 1),
		strings.Replace(string(document), `"max_devices_per_user":2`, `"max_devices_per_user":3`, 1),
		string(document) + `{}`,
	} {
		if _, err := Verify([]byte(changed), publicKey); err == nil {
			t.Fatal("changed entitlement passed signature verification")
		}
	}
}
