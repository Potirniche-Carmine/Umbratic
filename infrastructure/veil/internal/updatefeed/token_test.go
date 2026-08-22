package updatefeed

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

const orgUID = "org_testorganization"

// The key the customer build is stamped with, derived the way the release
// script derives it and the update feed derives it again.
func customerKey(master []byte) string {
	mac := hmac.New(sha256.New, master)
	mac.Write([]byte(orgUID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestTokenVerifiesAgainstTheDerivedKey(t *testing.T) {
	master := make([]byte, sha256.Size)
	for i := range master {
		master[i] = byte(i)
	}
	CustomerKey = customerKey(master)
	t.Cleanup(func() { CustomerKey = "" })

	now := time.Unix(1_780_000_000, 0)
	token := Token(orgUID, now)
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != orgUID || parts[1] != "1780000000" {
		t.Fatalf("token = %q", token)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("signature is not base64url: %v", err)
	}
	key, _ := base64.RawURLEncoding.DecodeString(CustomerKey)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		t.Fatal("the feed would reject this token")
	}
}

func TestTokenIsEmptyWithoutAUsableKey(t *testing.T) {
	for name, key := range map[string]string{"unset": "", "not base64": "!!", "wrong length": "AAAA"} {
		t.Run(name, func(t *testing.T) {
			CustomerKey = key
			t.Cleanup(func() { CustomerKey = "" })
			if token := Token(orgUID, time.Now()); token != "" {
				t.Fatalf("token = %q", token)
			}
		})
	}
	CustomerKey = customerKey(make([]byte, sha256.Size))
	t.Cleanup(func() { CustomerKey = "" })
	if token := Token("", time.Now()); token != "" {
		t.Fatalf("token without an org = %q", token)
	}
}
