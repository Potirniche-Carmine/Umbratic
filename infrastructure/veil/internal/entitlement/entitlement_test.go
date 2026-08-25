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

// omitempty is a signature constraint, not a style choice: every document
// signed before the monthly search pool existed has to keep marshaling byte
// identically, or adding the field would revoke every licence in the field.
func TestDocumentsSignedWithoutTheSearchPoolStillVerify(t *testing.T) {
	payload := Payload{
		Version: 1, OrgUID: "org_abcdefghijklmnop",
		MaxAuthorizedUsers: 2, MaxDevicesPerUser: 2,
	}
	canonical, _ := json.Marshal(payload)
	if strings.Contains(string(canonical), "max_searches_per_month") {
		t.Fatalf("an unbought pool must not appear in the signed bytes: %s", canonical)
	}
	document, publicKey := signedDocument(t, payload)
	verified, err := Verify(document, publicKey)
	if err != nil || verified.MaxSearchesPerMonth != 0 {
		t.Fatalf("a pre-search entitlement stopped verifying: %#v %v", verified, err)
	}
}

func TestSearchPoolIsSignedAndBounded(t *testing.T) {
	payload := Payload{
		Version: 1, OrgUID: "org_abcdefghijklmnop",
		MaxAuthorizedUsers: 2, MaxDevicesPerUser: 2, MaxSearchesPerMonth: 5000,
	}
	document, publicKey := signedDocument(t, payload)
	verified, err := Verify(document, publicKey)
	if err != nil || verified.MaxSearchesPerMonth != 5000 {
		t.Fatalf("a purchased pool failed to verify: %#v %v", verified, err)
	}
	if _, err := Verify([]byte(strings.Replace(string(document), `"max_searches_per_month":5000`, `"max_searches_per_month":500000`, 1)), publicKey); err == nil {
		t.Fatal("an enlarged pool passed signature verification")
	}
	for _, invalid := range []int{-1, 100_000_001} {
		payload.MaxSearchesPerMonth = invalid
		document, publicKey := signedDocument(t, payload)
		if _, err := Verify(document, publicKey); err == nil {
			t.Fatalf("a monthly pool of %d was accepted", invalid)
		}
	}
}
