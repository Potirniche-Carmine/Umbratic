package entitlement

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
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
	if _, err := Verify(document, publicKey); err != nil {
		t.Fatal(err)
	}
	changed := strings.Replace(string(document), `"max_authorized_users": 30`, `"max_authorized_users": 31`, 1)
	if _, err := Verify([]byte(changed), publicKey); err == nil {
		t.Fatal("changed seat limit passed signature verification")
	}
	if _, err := Verify(append(document, []byte(`{}`)...), publicKey); err == nil {
		t.Fatal("trailing entitlement data passed verification")
	}
	if strings.Contains(string(document), "max_searches_per_month") {
		t.Fatal("an organization without web search must sign the same bytes as before the field existed")
	}
}

func TestSignedEntitlementCarriesSearchAllowance(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signingKey := base64.RawURLEncoding.EncodeToString(privateKey)
	document, publicKey, err := Sign(Payload{
		Version: 1, OrgUID: "org_customerlicense",
		MaxAuthorizedUsers: 30, MaxDevicesPerUser: 2, MaxSearchesPerMonth: 20000,
	}, signingKey)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := Verify(document, publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if payload.MaxSearchesPerMonth != 20000 {
		t.Fatalf("search allowance did not survive the round trip: %d", payload.MaxSearchesPerMonth)
	}
	changed := strings.Replace(string(document), `"max_searches_per_month": 20000`, `"max_searches_per_month": 200000`, 1)
	if _, err := Verify([]byte(changed), publicKey); err == nil {
		t.Fatal("changed search allowance passed signature verification")
	}
	for _, searches := range []int{-1, 100_000_001} {
		if _, _, err := Sign(Payload{
			Version: 1, OrgUID: "org_customerlicense",
			MaxAuthorizedUsers: 30, MaxDevicesPerUser: 2, MaxSearchesPerMonth: searches,
		}, signingKey); err == nil {
			t.Fatalf("out-of-range search allowance %d was signed", searches)
		}
	}
}
