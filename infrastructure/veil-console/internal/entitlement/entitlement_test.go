package entitlement

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestSignedEntitlementRejectsLocalLimitChanges(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	document, publicKey, err := Sign(Payload{
		Version: 1, OrgUID: "org_customerlicense",
		MaxAuthorizedUsers: 30, MaxDevicesPerUser: 2,
	}, base64.RawURLEncoding.EncodeToString(privateKey))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(document, publicKey, time.Now()); err != nil {
		t.Fatal(err)
	}
	changed := strings.Replace(string(document), `"max_authorized_users": 30`, `"max_authorized_users": 31`, 1)
	if _, err := Verify([]byte(changed), publicKey, time.Now()); err == nil {
		t.Fatal("changed seat limit passed signature verification")
	}
	if _, err := Verify(append(document, []byte(`{}`)...), publicKey, time.Now()); err == nil {
		t.Fatal("trailing entitlement data passed verification")
	}
}
