package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"umbratic-veil/internal/entitlement"
)

const (
	DefaultEnrollmentCodeTTL = 24 * time.Hour
	ChallengeTTL             = 2 * time.Minute
	SessionTTL               = 15 * time.Minute
)

type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func failure(code, message string) error {
	return &Error{Code: code, Message: message}
}

type User struct {
	UID           string     `json:"uid"`
	Label         string     `json:"label,omitempty"`
	Access        string     `json:"access"`
	ActiveForDays int        `json:"active_for_days"`
	CreatedAt     time.Time  `json:"created_at"`
	ExpiresAt     time.Time  `json:"expires_at"`
	LastSeenAt    *time.Time `json:"last_seen_at,omitempty"`
}

type Device struct {
	UID         string     `json:"uid"`
	UserUID     string     `json:"user_uid"`
	Label       string     `json:"label"`
	PublicKey   string     `json:"public_key"`
	Fingerprint string     `json:"fingerprint"`
	Access      string     `json:"access"`
	EnrolledAt  time.Time  `json:"enrolled_at"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
	LastSeenAt  *time.Time `json:"last_seen_at,omitempty"`
}

type EnrollmentCode struct {
	UID        string     `json:"uid"`
	UserUID    string     `json:"user_uid"`
	Hash       string     `json:"hash"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	RedeemedAt *time.Time `json:"redeemed_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

type Challenge struct {
	UID       string    `json:"uid"`
	DeviceUID string    `json:"device_uid"`
	Value     string    `json:"value"`
	ExpiresAt time.Time `json:"expires_at"`
	Used      bool      `json:"used"`
}

type Session struct {
	Hash      string    `json:"hash"`
	DeviceUID string    `json:"device_uid"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

type SeatEvent struct {
	UserUID   string    `json:"user_uid"`
	Action    string    `json:"action"`
	CreatedAt time.Time `json:"created_at"`
}

type persisted struct {
	Version    int              `json:"version"`
	OrgUID     string           `json:"org_uid"`
	OrgName    string           `json:"org_name"`
	Users      []User           `json:"users"`
	Devices    []Device         `json:"devices"`
	Codes      []EnrollmentCode `json:"enrollment_codes"`
	Challenges []Challenge      `json:"challenges"`
	Sessions   []Session        `json:"sessions"`
	SeatEvents []SeatEvent      `json:"seat_events"`
}

type Store struct {
	mu          sync.Mutex
	path        string
	entitlement entitlement.Payload
	now         func() time.Time
	data        persisted
}

type EnrollmentResult struct {
	OrgUID    string `json:"org_uid"`
	OrgName   string `json:"org_name"`
	UserUID   string `json:"user_uid"`
	DeviceUID string `json:"device_uid"`
}

type ChallengeResult struct {
	ChallengeUID string    `json:"challenge_uid"`
	Challenge    string    `json:"challenge"`
	ExpiresAt    time.Time `json:"expires_at"`
}

type SessionResult struct {
	Token     string    `json:"session_token"`
	ExpiresAt time.Time `json:"expires_at"`
	OrgName   string    `json:"org_name"`
}

type CodeResult struct {
	CodeUID        string    `json:"code_uid"`
	EnrollmentCode string    `json:"enrollment_code"`
	ExpiresAt      time.Time `json:"expires_at"`
}

type Snapshot struct {
	OrgUID             string         `json:"org_uid"`
	OrgName            string         `json:"org_name"`
	MaxAuthorizedUsers int            `json:"max_authorized_users"`
	MaxDevicesPerUser  int            `json:"max_devices_per_user"`
	SeatsAssigned      int            `json:"seats_assigned"`
	SeatsAvailable     int            `json:"seats_available"`
	DevicesEnrolled    int            `json:"devices_enrolled"`
	Users              []SnapshotUser `json:"users"`
	RefreshedAt        time.Time      `json:"refreshed_at"`
}

type SnapshotUser struct {
	UID             string           `json:"uid"`
	Label           string           `json:"label,omitempty"`
	Access          string           `json:"access"`
	ActiveForDays   int              `json:"active_for_days"`
	CreatedAt       time.Time        `json:"created_at"`
	ExpiresAt       time.Time        `json:"expires_at"`
	LastSeenAt      *time.Time       `json:"last_seen_at,omitempty"`
	EnrollmentCodes []SnapshotCode   `json:"enrollment_codes"`
	Devices         []SnapshotDevice `json:"devices"`
	EnrolledDevices int              `json:"enrolled_devices"`
}

type SnapshotCode struct {
	UID        string     `json:"uid"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	RedeemedAt *time.Time `json:"redeemed_at,omitempty"`
}

type SnapshotDevice struct {
	UID         string     `json:"uid"`
	Label       string     `json:"label"`
	Fingerprint string     `json:"fingerprint"`
	Access      string     `json:"access"`
	EnrolledAt  time.Time  `json:"enrolled_at"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
	LastSeenAt  *time.Time `json:"last_seen_at,omitempty"`
}

func Open(path string, license entitlement.Payload) (*Store, error) {
	return openWithClock(path, license, time.Now)
}

func openWithClock(path string, license entitlement.Payload, now func() time.Time) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("identity store path is required")
	}
	store := &Store{
		path:        filepath.Clean(path),
		entitlement: license,
		now:         now,
		data:        persisted{Version: 3, OrgUID: license.OrgUID, OrgName: "My organization"},
	}
	payload, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(store.path), 0o700); err != nil {
			return nil, fmt.Errorf("create identity store directory: %w", err)
		}
		if err := store.persistLocked(); err != nil {
			return nil, err
		}
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read identity store: %w", err)
	}
	if err := json.Unmarshal(payload, &store.data); err != nil ||
		store.data.Version != 3 || store.data.OrgUID != license.OrgUID || strings.TrimSpace(store.data.OrgName) == "" {
		return nil, errors.New("identity store is invalid or belongs to another organization")
	}
	return store, nil
}

func (s *Store) CreateUser(label string, activeForDays int) (User, error) {
	label, err := cleanLabel(label, 160, true)
	if err != nil {
		return User{}, err
	}
	if !validActiveForDays(activeForDays) {
		return User{}, failure("invalid_active_period", "Select 30, 90, 180, or 365 days.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC().Truncate(time.Second)
	if s.assignedUsersLocked(now) >= s.entitlement.MaxAuthorizedUsers {
		return User{}, failure("seat_limit_reached", "All authorized user seats are assigned.")
	}
	user := User{
		UID: newUID("usr_"), Label: label, Access: "assigned", ActiveForDays: activeForDays,
		CreatedAt: now, ExpiresAt: now.Add(time.Duration(activeForDays) * 24 * time.Hour),
	}
	s.data.Users = append(s.data.Users, user)
	s.data.SeatEvents = append(s.data.SeatEvents, SeatEvent{
		UserUID: user.UID, Action: "assigned", CreatedAt: now,
	})
	return user, s.persistLocked()
}

func (s *Store) SetOrganizationName(name string) error {
	name, err := cleanLabel(name, 100, false)
	if err != nil {
		return failure("invalid_organization_name", "The organization name must contain 1 to 100 characters.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.OrgName = name
	return s.persistLocked()
}

func (s *Store) IssueEnrollmentCode(userUID string) (CodeResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user := s.userLocked(userUID)
	if user == nil {
		return CodeResult{}, failure("user_not_found", "The user was not found.")
	}
	if user.Access != "assigned" {
		return CodeResult{}, failure("user_deactivated", "The user is deactivated.")
	}
	now := s.now().UTC().Truncate(time.Second)
	if !userActiveAt(user, now) {
		return CodeResult{}, failure("user_expired", "The user access period has expired.")
	}
	activeDevices := 0
	for _, device := range s.data.Devices {
		if device.UserUID == userUID && device.Access == "enrolled" {
			activeDevices++
		}
	}
	if activeDevices >= s.entitlement.MaxDevicesPerUser {
		return CodeResult{}, failure("device_limit_reached", "This user has reached the enrolled device limit.")
	}
	for index := range s.data.Codes {
		code := &s.data.Codes[index]
		if code.UserUID == userUID && code.RedeemedAt == nil && code.RevokedAt == nil && now.Before(code.ExpiresAt) {
			code.RevokedAt = timePointer(now)
		}
	}
	plain := "umbr_" + randomText(32)
	code := EnrollmentCode{
		UID: newUID("code_"), UserUID: userUID, Hash: hashSecret(plain),
		CreatedAt: now, ExpiresAt: now.Add(DefaultEnrollmentCodeTTL),
	}
	s.data.Codes = append(s.data.Codes, code)
	if err := s.persistLocked(); err != nil {
		return CodeResult{}, err
	}
	return CodeResult{CodeUID: code.UID, EnrollmentCode: plain, ExpiresAt: code.ExpiresAt}, nil
}

func (s *Store) RevokeEnrollmentCode(codeUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC().Truncate(time.Second)
	for index := range s.data.Codes {
		code := &s.data.Codes[index]
		if code.UID != codeUID {
			continue
		}
		if code.RedeemedAt != nil || code.RevokedAt != nil || !now.Before(code.ExpiresAt) {
			return failure("enrollment_code_not_pending", "The Enrollment code is not pending.")
		}
		code.RevokedAt = timePointer(now)
		return s.persistLocked()
	}
	return failure("enrollment_code_not_found", "The Enrollment code was not found.")
}

func (s *Store) DeactivateUser(userUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	user := s.userLocked(userUID)
	if user == nil {
		return failure("user_not_found", "The user was not found.")
	}
	if user.Access == "deactivated" {
		return nil
	}
	now := s.now().UTC().Truncate(time.Second)
	user.Access = "deactivated"
	s.data.SeatEvents = append(s.data.SeatEvents, SeatEvent{
		UserUID: user.UID, Action: "released", CreatedAt: now,
	})
	for index := range s.data.Codes {
		code := &s.data.Codes[index]
		if code.UserUID == userUID && code.RedeemedAt == nil && code.RevokedAt == nil {
			code.RevokedAt = timePointer(now)
		}
	}
	for index := range s.data.Devices {
		device := &s.data.Devices[index]
		if device.UserUID == userUID && device.Access == "enrolled" {
			device.Access = "revoked"
			device.RevokedAt = timePointer(now)
		}
	}
	s.removeSessionsForUserLocked(userUID)
	return s.persistLocked()
}

func (s *Store) ReactivateUser(userUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	user := s.userLocked(userUID)
	if user == nil {
		return failure("user_not_found", "The user was not found.")
	}
	now := s.now().UTC().Truncate(time.Second)
	if userActiveAt(user, now) {
		return nil
	}
	if s.assignedUsersLocked(now) >= s.entitlement.MaxAuthorizedUsers {
		return failure("seat_limit_reached", "All authorized user seats are assigned.")
	}
	user.Access = "assigned"
	user.ExpiresAt = now.Add(time.Duration(user.ActiveForDays) * 24 * time.Hour)
	s.data.SeatEvents = append(s.data.SeatEvents, SeatEvent{
		UserUID: user.UID, Action: "reassigned", CreatedAt: now,
	})
	return s.persistLocked()
}

func (s *Store) RevokeDevice(deviceUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	device := s.deviceLocked(deviceUID)
	if device == nil {
		return failure("device_not_found", "The device was not found.")
	}
	if device.Access == "revoked" {
		return nil
	}
	now := s.now().UTC().Truncate(time.Second)
	device.Access = "revoked"
	device.RevokedAt = timePointer(now)
	s.removeSessionsForDeviceLocked(deviceUID)
	return s.persistLocked()
}

func (s *Store) Enroll(codeText, publicKeyText, deviceLabel string) (EnrollmentResult, error) {
	if !strings.HasPrefix(codeText, "umbr_") {
		return EnrollmentResult{}, failure("enrollment_code_invalid", "The Enrollment code is invalid.")
	}
	deviceLabel, err := cleanLabel(deviceLabel, 100, false)
	if err != nil {
		return EnrollmentResult{}, failure("invalid_device_label", err.Error())
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(publicKeyText)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return EnrollmentResult{}, failure("invalid_public_key", "The device public key is invalid.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC().Truncate(time.Second)
	providedHash := hashSecret(codeText)
	var code *EnrollmentCode
	for index := range s.data.Codes {
		if constantTextEqual(s.data.Codes[index].Hash, providedHash) {
			code = &s.data.Codes[index]
			break
		}
	}
	if code == nil || code.RevokedAt != nil || code.RedeemedAt != nil {
		return EnrollmentResult{}, failure("enrollment_code_invalid", "The Enrollment code is invalid.")
	}
	if !now.Before(code.ExpiresAt) {
		return EnrollmentResult{}, failure("enrollment_code_expired", "The Enrollment code has expired.")
	}
	user := s.userLocked(code.UserUID)
	if user == nil || user.Access != "assigned" {
		return EnrollmentResult{}, failure("user_deactivated", "The user is deactivated.")
	}
	if !userActiveAt(user, now) {
		return EnrollmentResult{}, failure("user_expired", "The user access period has expired.")
	}
	activeDevices := 0
	for _, device := range s.data.Devices {
		if device.UserUID == user.UID && device.Access == "enrolled" {
			activeDevices++
		}
		if device.PublicKey == publicKeyText {
			return EnrollmentResult{}, failure("device_already_enrolled", "This device key is already enrolled.")
		}
	}
	if activeDevices >= s.entitlement.MaxDevicesPerUser {
		return EnrollmentResult{}, failure("device_limit_reached", "This user has reached the enrolled device limit.")
	}
	sum := sha256.Sum256(publicKey)
	device := Device{
		UID: newUID("dev_"), UserUID: user.UID, Label: deviceLabel,
		PublicKey: publicKeyText, Fingerprint: base64.RawURLEncoding.EncodeToString(sum[:9]),
		Access: "enrolled", EnrolledAt: now,
	}
	code.RedeemedAt = timePointer(now)
	s.data.Devices = append(s.data.Devices, device)
	if err := s.persistLocked(); err != nil {
		return EnrollmentResult{}, err
	}
	return EnrollmentResult{
		OrgUID: s.entitlement.OrgUID, OrgName: s.data.OrgName,
		UserUID: user.UID, DeviceUID: device.UID,
	}, nil
}

func (s *Store) NewChallenge(deviceUID string) (ChallengeResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC().Truncate(time.Second)
	device := s.deviceLocked(deviceUID)
	if device == nil || device.Access != "enrolled" {
		return ChallengeResult{}, failure("device_not_authorized", "The device is not authorized.")
	}
	user := s.userLocked(device.UserUID)
	if !userActiveAt(user, now) {
		return ChallengeResult{}, failure("device_not_authorized", "The device is not authorized.")
	}
	s.pruneLocked(now)
	challenge := Challenge{
		UID: newUID("chal_"), DeviceUID: deviceUID,
		Value:     "umbratic-device-session-v1." + deviceUID + "." + randomText(32),
		ExpiresAt: now.Add(ChallengeTTL),
	}
	s.data.Challenges = append(s.data.Challenges, challenge)
	if err := s.persistLocked(); err != nil {
		return ChallengeResult{}, err
	}
	return ChallengeResult{ChallengeUID: challenge.UID, Challenge: challenge.Value, ExpiresAt: challenge.ExpiresAt}, nil
}

func (s *Store) NewSession(challengeUID, signatureText string) (SessionResult, error) {
	signature, err := base64.RawURLEncoding.DecodeString(signatureText)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return SessionResult{}, failure("challenge_proof_invalid", "The device proof is invalid.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC().Truncate(time.Second)
	var challenge *Challenge
	for index := range s.data.Challenges {
		if s.data.Challenges[index].UID == challengeUID {
			challenge = &s.data.Challenges[index]
			break
		}
	}
	if challenge == nil || challenge.Used || !now.Before(challenge.ExpiresAt) {
		return SessionResult{}, failure("challenge_invalid", "The challenge is invalid or expired.")
	}
	device := s.deviceLocked(challenge.DeviceUID)
	if device == nil || device.Access != "enrolled" {
		return SessionResult{}, failure("device_not_authorized", "The device is not authorized.")
	}
	user := s.userLocked(device.UserUID)
	if !userActiveAt(user, now) {
		return SessionResult{}, failure("device_not_authorized", "The device is not authorized.")
	}
	publicKey, _ := base64.RawURLEncoding.DecodeString(device.PublicKey)
	if !ed25519.Verify(ed25519.PublicKey(publicKey), []byte(challenge.Value), signature) {
		return SessionResult{}, failure("challenge_proof_invalid", "The device proof is invalid.")
	}
	challenge.Used = true
	plain := "umbs_" + randomText(32)
	session := Session{Hash: hashSecret(plain), DeviceUID: device.UID, CreatedAt: now, ExpiresAt: now.Add(SessionTTL)}
	s.data.Sessions = append(s.data.Sessions, session)
	if err := s.persistLocked(); err != nil {
		return SessionResult{}, err
	}
	return SessionResult{Token: plain, ExpiresAt: session.ExpiresAt, OrgName: s.data.OrgName}, nil
}

func (s *Store) Authenticate(token string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC()
	hash := hashSecret(token)
	for _, session := range s.data.Sessions {
		if !constantTextEqual(session.Hash, hash) {
			continue
		}
		if !now.Before(session.ExpiresAt) {
			return "", failure("session_expired", "The session has expired.")
		}
		device := s.deviceLocked(session.DeviceUID)
		if device == nil || device.Access != "enrolled" {
			return "", failure("device_not_authorized", "The device is not authorized.")
		}
		user := s.userLocked(device.UserUID)
		if !userActiveAt(user, now) {
			return "", failure("device_not_authorized", "The device is not authorized.")
		}
		return device.UID, nil
	}
	return "", failure("session_invalid", "The session is invalid.")
}

func (s *Store) Touch(deviceUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC().Truncate(time.Second)
	device := s.deviceLocked(deviceUID)
	if device == nil || device.Access != "enrolled" {
		return failure("device_not_authorized", "The device is not authorized.")
	}
	user := s.userLocked(device.UserUID)
	if !userActiveAt(user, now) {
		return failure("device_not_authorized", "The device is not authorized.")
	}
	device.LastSeenAt = timePointer(now)
	if user.LastSeenAt == nil || user.LastSeenAt.Before(now) {
		user.LastSeenAt = timePointer(now)
	}
	return s.persistLocked()
}

func (s *Store) Logout(token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	hash := hashSecret(token)
	next := s.data.Sessions[:0]
	for _, session := range s.data.Sessions {
		if !constantTextEqual(session.Hash, hash) {
			next = append(next, session)
		}
	}
	s.data.Sessions = next
	return s.persistLocked()
}

func (s *Store) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC().Truncate(time.Second)
	snapshot := Snapshot{
		OrgUID: s.entitlement.OrgUID, OrgName: s.data.OrgName,
		MaxAuthorizedUsers: s.entitlement.MaxAuthorizedUsers,
		MaxDevicesPerUser:  s.entitlement.MaxDevicesPerUser, RefreshedAt: now,
	}
	snapshot.SeatsAssigned = s.assignedUsersLocked(now)
	snapshot.SeatsAvailable = s.entitlement.MaxAuthorizedUsers - snapshot.SeatsAssigned
	for _, user := range s.data.Users {
		access := user.Access
		if access == "assigned" && !userActiveAt(&user, now) {
			access = "expired"
		}
		item := SnapshotUser{
			UID: user.UID, Label: user.Label, Access: access, ActiveForDays: user.ActiveForDays,
			CreatedAt: user.CreatedAt, ExpiresAt: user.ExpiresAt, LastSeenAt: user.LastSeenAt,
			EnrollmentCodes: []SnapshotCode{}, Devices: []SnapshotDevice{},
		}
		for _, code := range s.data.Codes {
			if code.UserUID != user.UID {
				continue
			}
			status := "pending"
			switch {
			case code.RedeemedAt != nil:
				status = "redeemed"
			case code.RevokedAt != nil:
				status = "revoked"
			case !now.Before(code.ExpiresAt):
				status = "expired"
			}
			item.EnrollmentCodes = append(item.EnrollmentCodes, SnapshotCode{
				UID: code.UID, Status: status, CreatedAt: code.CreatedAt,
				ExpiresAt: code.ExpiresAt, RedeemedAt: code.RedeemedAt,
			})
		}
		for _, device := range s.data.Devices {
			if device.UserUID != user.UID {
				continue
			}
			item.Devices = append(item.Devices, SnapshotDevice{
				UID: device.UID, Label: device.Label, Fingerprint: device.Fingerprint,
				Access: device.Access, EnrolledAt: device.EnrolledAt,
				RevokedAt: device.RevokedAt, LastSeenAt: device.LastSeenAt,
			})
			if device.Access == "enrolled" {
				item.EnrolledDevices++
				snapshot.DevicesEnrolled++
			}
		}
		snapshot.Users = append(snapshot.Users, item)
	}
	return snapshot
}

func (s *Store) assignedUsersLocked(now time.Time) int {
	count := 0
	for index := range s.data.Users {
		if userActiveAt(&s.data.Users[index], now) {
			count++
		}
	}
	return count
}

func userActiveAt(user *User, now time.Time) bool {
	return user != nil && user.Access == "assigned" && now.Before(user.ExpiresAt)
}

func validActiveForDays(days int) bool {
	return days == 30 || days == 90 || days == 180 || days == 365
}

func (s *Store) userLocked(uid string) *User {
	for index := range s.data.Users {
		if s.data.Users[index].UID == uid {
			return &s.data.Users[index]
		}
	}
	return nil
}

func (s *Store) deviceLocked(uid string) *Device {
	for index := range s.data.Devices {
		if s.data.Devices[index].UID == uid {
			return &s.data.Devices[index]
		}
	}
	return nil
}

func (s *Store) removeSessionsForDeviceLocked(deviceUID string) {
	next := s.data.Sessions[:0]
	for _, session := range s.data.Sessions {
		if session.DeviceUID != deviceUID {
			next = append(next, session)
		}
	}
	s.data.Sessions = next
}

func (s *Store) removeSessionsForUserLocked(userUID string) {
	next := s.data.Sessions[:0]
	for _, session := range s.data.Sessions {
		device := s.deviceLocked(session.DeviceUID)
		if device == nil || device.UserUID != userUID {
			next = append(next, session)
		}
	}
	s.data.Sessions = next
}

func (s *Store) pruneLocked(now time.Time) {
	challenges := s.data.Challenges[:0]
	for _, challenge := range s.data.Challenges {
		if !challenge.Used && now.Before(challenge.ExpiresAt) {
			challenges = append(challenges, challenge)
		}
	}
	s.data.Challenges = challenges
	sessions := s.data.Sessions[:0]
	for _, session := range s.data.Sessions {
		if now.Before(session.ExpiresAt) {
			sessions = append(sessions, session)
		}
	}
	s.data.Sessions = sessions
}

func (s *Store) persistLocked() error {
	payload, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	temporary := s.path + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return fmt.Errorf("write identity store: %w", err)
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, s.path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace identity store: %w", err)
	}
	return nil
}

func cleanLabel(value string, limit int, allowEmpty bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" && allowEmpty {
		return "", nil
	}
	if value == "" || len(value) > limit || strings.ContainsAny(value, "\r\n\x00") {
		return "", fmt.Errorf("label must contain 1 to %d characters", limit)
	}
	return value, nil
}

func newUID(prefix string) string { return prefix + randomText(12) }

func randomText(size int) string {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		panic("operating system random source failed")
	}
	return base64.RawURLEncoding.EncodeToString(value)
}

func hashSecret(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func constantTextEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func timePointer(value time.Time) *time.Time { return &value }
