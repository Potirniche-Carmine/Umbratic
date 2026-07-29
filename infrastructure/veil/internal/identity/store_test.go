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

func TestOpenRejectsPreviousIdentityState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	previous, err := json.Marshal(persisted{Version: 2, OrgUID: testLicense().OrgUID, OrgName: "Northwind"})
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
	userA, err := store.CreateUser("Alice", 30)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateUser("Bob", 90); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateUser("Charlie", 30); identityCode(t, err) != "seat_limit_reached" {
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

	codeTwo, _ := store.IssueEnrollmentCode(userA.UID)
	publicTwo, _ := deviceKey(t)
	if _, err := store.Enroll(codeTwo.EnrollmentCode, publicTwo, "Home laptop"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.IssueEnrollmentCode(userA.UID); identityCode(t, err) != "device_limit_reached" {
		t.Fatal("third device code did not hit the device limit")
	}

	challenge, err := store.NewChallenge(deviceOne.DeviceUID)
	if err != nil {
		t.Fatal(err)
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
	before := store.Snapshot()
	if before.Users[0].LastSeenAt != nil {
		t.Fatal("session issue changed Last seen")
	}
	now = now.Add(5 * time.Minute)
	if err := store.Touch(deviceOne.DeviceUID); err != nil {
		t.Fatal(err)
	}
	after := store.Snapshot()
	if after.Users[0].LastSeenAt == nil || after.Users[0].Devices[0].LastSeenAt == nil || after.Users[0].Devices[1].LastSeenAt != nil {
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
	if snapshot.SeatsAssigned != 1 || snapshot.Users[0].Access != "deactivated" || snapshot.Users[0].Devices[0].Access != "revoked" {
		t.Fatalf("deactivation was not atomic: %#v", snapshot)
	}
	if _, err := store.CreateUser("Charlie", 180); err != nil {
		t.Fatal("deactivation did not release a seat:", err)
	}
	persistedData, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved persisted
	if err := json.Unmarshal(persistedData, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.SeatEvents) != 4 ||
		saved.SeatEvents[0].Action != "assigned" ||
		saved.SeatEvents[2].Action != "released" ||
		saved.SeatEvents[3].Action != "assigned" {
		t.Fatalf("seat events were not persisted: %#v", saved.SeatEvents)
	}
}

func TestUserAccessPeriodExpiresAndCanBeRenewed(t *testing.T) {
	now := time.Date(2026, 7, 27, 18, 0, 0, 0, time.UTC)
	store, err := openWithClock(filepath.Join(t.TempDir(), "identity.json"), testLicense(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateUser("Invalid", 31); identityCode(t, err) != "invalid_active_period" {
		t.Fatal("unsupported active period was accepted")
	}
	user, err := store.CreateUser("Alice", 30)
	if err != nil {
		t.Fatal(err)
	}
	code, err := store.IssueEnrollmentCode(user.UID)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, _ := deviceKey(t)
	if _, err := store.Enroll(code.EnrollmentCode, publicKey, "Work laptop"); err != nil {
		t.Fatal(err)
	}

	now = now.Add(31 * 24 * time.Hour)
	snapshot := store.Snapshot()
	if snapshot.SeatsAssigned != 0 || snapshot.SeatsAvailable != 2 || snapshot.Users[0].Access != "expired" {
		t.Fatalf("expired access did not release the seat: %#v", snapshot)
	}
	if _, err := store.IssueEnrollmentCode(user.UID); identityCode(t, err) != "user_expired" {
		t.Fatal("expired user received an Enrollment code")
	}
	if _, err := store.NewChallenge(snapshot.Users[0].Devices[0].UID); identityCode(t, err) != "device_not_authorized" {
		t.Fatal("expired user device was authorized")
	}
	if err := store.ReactivateUser(user.UID); err != nil {
		t.Fatal(err)
	}
	renewed := store.Snapshot()
	if renewed.SeatsAssigned != 1 || renewed.Users[0].Access != "assigned" ||
		!renewed.Users[0].ExpiresAt.Equal(now.Add(30*24*time.Hour)) {
		t.Fatalf("reactivation did not renew the access period: %#v", renewed.Users[0])
	}
}
