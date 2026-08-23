// Package updatefeed mints the token that lets this company's desktop apps
// download releases from the Umbratic update feed.
//
// The feed is a Cloudflare Worker in front of the release bucket. It knows one
// master key; this server holds only HMAC(master, org_uid), baked into the
// binary at build time, from which neither the master key nor another
// company's key can be recovered. A token is that key over a timestamp, so the
// Worker can verify it without storing anything, and it stops being accepted
// thirty days after it was minted.
//
// Veil never reaches the feed itself. The desktop app collects a fresh token
// every time it opens a session and presents it when it checks for updates, so
// an air-gapped server keeps its apps current with no outbound connection, and
// a server that stops minting — because its licence ended, or because it is
// gone — leaves them at the version they have.
package updatefeed

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
	"time"
)

// CustomerKey is set in customer release binaries with -ldflags: one
// base64url-encoded 32-byte key. A build without it mints no tokens, which is
// what a development or evaluation server should do.
var CustomerKey string

// Token returns `org_uid.unix_seconds.signature`, or "" when this build has no
// customer key.
func Token(orgUID string, now time.Time) string {
	key, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(CustomerKey))
	if err != nil || len(key) != sha256.Size || orgUID == "" {
		return ""
	}
	message := orgUID + "." + strconv.FormatInt(now.UTC().Unix(), 10)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	return message + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
