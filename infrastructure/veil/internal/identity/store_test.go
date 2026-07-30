package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"umbratic-veil/internal/entitlement"
)

func testLicense() entitlement.Payload {
	return entitlement.Payload{
		Version: 1, OrgUID: "org_testenterprise",
		MaxAuthorizedUsers: 2, MaxDevicesPerUser: 2,
	}
}

func deviceKey(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(publicKey), privateKey
}

func identityCode(t *testing.T, err error) string {
	t.Helper()
	var identityError *Error
	if !errors.As(err, &identityError) {
		t.Fatalf("expected identity error, got %v", err)
	}
	return identityError.Code
}

func enrollDevice(t *testing.T, store *Store, userUID, label string) (EnrollmentResult, ed25519.PrivateKey) {
	t.Helper()
	code, err := store.IssueEnrollmentCode(userUID)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey := deviceKey(t)
	device, err := store.Enroll(code.EnrollmentCode, publicKey, label)
	if err != nil {
		t.Fatal(err)
	}
	return device, privateKey
}

func TestOpenRejectsPreviousIdentityState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	previous, err := json.Marshal(persisted{Version: 3, OrgUID: testLicense().OrgUID, OrgName: "Northwind"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, previous, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path, testLicense()); err == nil {
		t.Fatal("previous identity state was accepted")
	}
}

func TestSeatsDevicesSessionsRevocationAndActivity(t *testing.T) {
	now := time.Date(2026, 7, 27, 18, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "identity.json")
	store, err := openWithClock(path, testLicense(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetOrganizationName("Northwind"); err != nil {
		t.Fatal(err)
	}
	userA, err := store.CreateUser("Alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateUser("Bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateUser("Charlie"); identityCode(t, err) != "seat_limit_reached" {
		t.Fatal("third assigned user did not hit the seat limit")
	}

	codeOne, err := store.IssueEnrollmentCode(userA.UID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(codeOne.EnrollmentCode, "umbr_") {
		t.Fatalf("unexpected Enrollment code prefix: %s", codeOne.EnrollmentCode)
	}
	replacement, err := store.IssueEnrollmentCode(userA.UID)
	if err != nil {
		t.Fatal(err)
	}
	publicOne, privateOne := deviceKey(t)
	if _, err := store.Enroll(codeOne.EnrollmentCode, publicOne, "Old code"); identityCode(t, err) != "enrollment_code_invalid" {
		t.Fatal("replaced Enrollment code remained active")
	}
	deviceOne, err := store.Enroll(replacement.EnrollmentCode, publicOne, "Work laptop")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Enroll(replacement.EnrollmentCode, publicOne, "Replay"); identityCode(t, err) != "enrollment_code_invalid" {
		t.Fatal("Enrollment code replay did not fail")
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), codeOne.EnrollmentCode) || strings.Contains(string(stored), replacement.EnrollmentCode) {
		t.Fatal("plaintext Enrollment code was stored")
	}

	enrollDevice(t, store, userA.UID, "Home laptop")
	if _, err := store.IssueEnrollmentCode(userA.UID); identityCode(t, err) != "device_limit_reached" {
		t.Fatal("third device code did not hit the device limit")
	}

	oldChallenge, err := store.NewChallenge(deviceOne.DeviceUID)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := store.NewChallenge(deviceOne.DeviceUID)
	if err != nil {
		t.Fatal(err)
	}
	oldSignature := ed25519.Sign(privateOne, []byte(oldChallenge.Challenge))
	if _, err := store.NewSession(oldChallenge.ChallengeUID, base64.RawURLEncoding.EncodeToString(oldSignature)); identityCode(t, err) != "challenge_invalid" {
		t.Fatal("a replaced challenge remained active")
	}
	signature := ed25519.Sign(privateOne, []byte(challenge.Challenge))
	session, err := store.NewSession(challenge.ChallengeUID, base64.RawURLEncoding.EncodeToString(signature))
	if err != nil {
		t.Fatal(err)
	}
	if deviceOne.OrgName != "Northwind" || session.OrgName != "Northwind" {
		t.Fatalf("organization name was not sent to the device: %#v %#v", deviceOne, session)
	}
	if _, err := store.NewSession(challenge.ChallengeUID, base64.RawURLEncoding.EncodeToString(signature)); identityCode(t, err) != "challenge_invalid" {
		t.Fatal("challenge replay did not fail")
	}
	if authenticatedDevice, err := store.Authenticate(session.Token); err != nil || authenticatedDevice != deviceOne.DeviceUID {
		t.Fatalf("session authentication failed: %s %v", authenticatedDevice, err)
	}
	stored, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), challenge.Challenge) || strings.Contains(string(stored), session.Token) ||
		strings.Contains(string(stored), `"challenges"`) || strings.Contains(string(stored), `"sessions"`) {
		t.Fatal("ephemeral authentication state was persisted")
	}

	before := store.Snapshot()
	if before.Users[0].LastSeenAt != nil {
		t.Fatal("session issue changed Last seen")
	}
	if err := store.Touch(deviceOne.DeviceUID); err != nil {
		t.Fatal(err)
	}
	firstTouch := store.Snapshot()
	firstSeen := *firstTouch.Users[0].Devices[0].LastSeenAt
	now = now.Add(time.Minute)
	if err := store.Touch(deviceOne.DeviceUID); err != nil {
		t.Fatal(err)
	}
	if got := store.Snapshot().Users[0].Devices[0].LastSeenAt; got == nil || !got.Equal(firstSeen) {
		t.Fatal("Last seen was written before the coalescing interval")
	}
	now = now.Add(4 * time.Minute)
	if err := store.Touch(deviceOne.DeviceUID); err != nil {
		t.Fatal(err)
	}
	after := store.Snapshot()
	if after.Users[0].LastSeenAt == nil || after.Users[0].Devices[0].LastSeenAt == nil ||
		after.Users[0].Devices[0].LastSeenAt.Equal(firstSeen) || after.Users[0].Devices[1].LastSeenAt != nil {
		t.Fatal("Last seen did not update only the authenticated device and its user")
	}
	lastSeen := *after.Users[0].LastSeenAt
	if err := store.RevokeDevice(deviceOne.DeviceUID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Authenticate(session.Token); identityCode(t, err) != "session_invalid" {
		t.Fatal("revoked device session still authenticated")
	}
	if got := store.Snapshot().Users[0].LastSeenAt; got == nil || !got.Equal(lastSeen) {
		t.Fatal("device revoke changed Last seen history")
	}

	if err := store.DeactivateUser(userA.UID); err != nil {
		t.Fatal(err)
	}
	snapshot := store.Snapshot()
	if snapshot.SeatsAssigned != 1 || snapshot.Users[0].Access != "deactivated" || snapshot.Users[0].Devices[1].Access != "revoked" {
		t.Fatalf("deactivation was not atomic: %#v", snapshot)
	}
	if _, err := store.CreateUser("Charlie"); err != nil {
		t.Fatal("deactivation did not release a seat:", err)
	}
}

func TestUsersRemainAssignedUntilAnAdministratorDeactivatesThem(t *testing.T) {
	now := time.Date(2026, 7, 27, 18, 0, 0, 0, time.UTC)
	store, err := openWithClock(filepath.Join(t.TempDir(), "identity.json"), testLicense(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.CreateUser("Alice")
	if err != nil {
		t.Fatal(err)
	}
	device, _ := enrollDevice(t, store, user.UID, "Work laptop")

	now = now.Add(400 * 24 * time.Hour)
	snapshot := store.Snapshot()
	if snapshot.SeatsAssigned != 1 || snapshot.Users[0].Access != "assigned" {
		t.Fatalf("time changed the user assignment: %#v", snapshot)
	}
	if _, err := store.NewChallenge(device.DeviceUID); err != nil {
		t.Fatal("time disabled an assigned user:", err)
	}
	if err := store.DeactivateUser(user.UID); err != nil {
		t.Fatal(err)
	}
	if err := store.ReactivateUser(user.UID); err != nil {
		t.Fatal(err)
	}
	reactivated := store.Snapshot()
	if reactivated.SeatsAssigned != 1 || reactivated.Users[0].Access != "assigned" {
		t.Fatalf("reactivation did not restore the user assignment: %#v", reactivated.Users[0])
	}
}

func TestEphemeralSessionsDoNotSurviveRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	store, err := Open(path, testLicense())
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.CreateUser("Alice")
	if err != nil {
		t.Fatal(err)
	}
	device, privateKey := enrollDevice(t, store, user.UID, "Work laptop")
	challenge, err := store.NewChallenge(device.DeviceUID)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, []byte(challenge.Challenge))
	session, err := store.NewSession(challenge.ChallengeUID, base64.RawURLEncoding.EncodeToString(signature))
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path, testLicense())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Authenticate(session.Token); identityCode(t, err) != "session_invalid" {
		t.Fatal("session survived a store restart")
	}
}

func TestFailedPersistenceDoesNotChangeMemory(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "identity.json"), testLicense())
	if err != nil {
		t.Fatal(err)
	}
	store.path = filepath.Join(t.TempDir(), "missing", "identity.json")
	if _, err := store.CreateUser("Alice"); err == nil {
		t.Fatal("write to a missing directory succeeded")
	}
	if got := store.Snapshot(); len(got.Users) != 0 || got.SeatsAssigned != 0 {
		t.Fatalf("failed persistence changed memory: %#v", got)
	}
}

func TestLowerReplacementEntitlementBlocksProductAccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	store, err := Open(path, testLicense())
	if err != nil {
		t.Fatal(err)
	}
	alice, err := store.CreateUser("Alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateUser("Bob"); err != nil {
		t.Fatal(err)
	}
	device, _ := enrollDevice(t, store, alice.UID, "Work laptop")

	lower := testLicense()
	lower.MaxAuthorizedUsers = 1
	reopened, err := Open(path, lower)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.NewChallenge(device.DeviceUID); identityCode(t, err) != "entitlement_over_limit" {
		t.Fatal("over-limit product access was not blocked")
	}
	if got := reopened.Snapshot(); len(got.Users) != 2 {
		t.Fatal("the over-limit state was not available for administration")
	}
}
