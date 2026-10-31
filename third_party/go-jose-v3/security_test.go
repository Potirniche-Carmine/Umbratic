package jose

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	stdjson "encoding/json"
	"math/big"
	"testing"

	"github.com/go-jose/go-jose/v3/json"
)

func TestRSAJWKBoundsBeforePrivateKeyValidation(t *testing.T) {
	encode := func(n *big.Int) string { return base64.RawURLEncoding.EncodeToString(n.Bytes()) }
	for _, modulusBits := range []int{2048, 4096, 4097} {
		n := new(big.Int).Lsh(big.NewInt(1), uint(modulusBits-1))
		raw, err := stdjson.Marshal(map[string]string{"kty": "RSA", "n": encode(n), "e": "AQAB"})
		if err != nil {
			t.Fatal(err)
		}
		var key JSONWebKey
		err = json.Unmarshal(raw, &key)
		if modulusBits <= 4096 && err != nil {
			t.Fatal("bounded public RSA key rejected:", err)
		}
		if modulusBits > 4096 && err == nil {
			t.Fatal("oversized RSA modulus accepted")
		}
	}
	// A small modulus with a huge prime is rejected before expensive rsa.Validate.
	raw, err := stdjson.Marshal(map[string]string{
		"kty": "RSA", "n": encode(new(big.Int).Lsh(big.NewInt(1), 2047)), "e": "AQAB", "d": "Aw",
		"p": encode(new(big.Int).Lsh(big.NewInt(1), 16383)), "q": "Aw",
	})
	if err != nil {
		t.Fatal(err)
	}
	var invalid JSONWebKey
	if err := json.Unmarshal(raw, &invalid); err == nil {
		t.Fatal("mismatched oversized RSA primes accepted")
	}
	valid, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(JSONWebKey{Key: valid})
	if err != nil {
		t.Fatal(err)
	}
	var decoded JSONWebKey
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal("valid private RSA key rejected:", err)
	}
}

func TestUntrustedJWKAndEPKHeadersRejectPrivateMaterial(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, material := range []interface{}{public, private} {
		data, err := json.Marshal(JSONWebKey{Key: material})
		if err != nil {
			t.Fatal(err)
		}
		message := json.RawMessage(data)
		_, jwkErr := (rawHeader{headerJWK: &message}).sanitized()
		_, epkErr := (rawHeader{headerEPK: &message}).getEPK()
		_, isPrivate := material.(ed25519.PrivateKey)
		if (jwkErr != nil) != isPrivate || (epkErr != nil) != isPrivate {
			t.Fatal("header public-key restriction was not enforced")
		}
	}
}
