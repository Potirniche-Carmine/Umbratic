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
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"umbratic-veil/internal/entitlement"
	"umbratic-veil/internal/updatefeed"
)

const (
	DefaultEnrollmentCodeTTL = 24 * time.Hour
	ChallengeTTL             = 2 * time.Minute
	SessionTTL               = 15 * time.Minute
	lastSeenWriteInterval    = 5 * time.Minute
	pruneInterval            = 1 * time.Minute
	maxActiveChallenges      = 4096
	maxActiveSessions        = 65536
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
	UID        string     `json:"uid"`
	Label      string     `json:"label,omitempty"`
	Access     string     `json:"access"`
	CreatedAt  time.Time  `json:"created_at"`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`
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
	UID       string
	DeviceUID string
	Value     string
	CreatedAt time.Time
	ExpiresAt time.Time
}

type Session struct {
	Hash      string
	DeviceUID string
	CreatedAt time.Time
	ExpiresAt time.Time
}

type persisted struct {
	Version int              `json:"version"`
	OrgUID  string           `json:"org_uid"`
	OrgName string           `json:"org_name"`
	Users   []User           `json:"users"`
	Devices []Device         `json:"devices"`
	Codes   []EnrollmentCode `json:"enrollment_codes"`
}

type Store struct {
	mu          sync.RWMutex
	path        string
	entitlement entitlement.Payload
	now         func() time.Time
	data        persisted
	challenges  map[string]Challenge
	sessions    map[string]Session
	lastPrune   time.Time
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
	// UpdateToken lets this device download app releases from the update feed
	// until it opens its next session. Empty on a build with no customer key.
	UpdateToken string `json:"update_token,omitempty"`
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
	CreatedAt       time.Time        `json:"created_at"`
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
		data:        persisted{Version: 4, OrgUID: license.OrgUID, OrgName: "My organization"},
		challenges:  map[string]Challenge{},
		sessions:    map[string]Session{},
	}
	payload, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(store.path), 0o700); err != nil {
			return nil, fmt.Errorf("create identity store directory: %w", err)
		}
		if err := persistData(store.path, store.data); err != nil {
			return nil, err
		}
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read identity store: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&store.data); err != nil {
		return nil, errors.New("identity store is invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) ||
		store.data.Version != 4 || store.data.OrgUID != license.OrgUID || strings.TrimSpace(store.data.OrgName) == "" {
		return nil, errors.New("identity store is invalid or belongs to another organization")
	}
	return store, nil
}

func (s *Store) CreateUser(label string) (User, error) {
	label, err := cleanLabel(label, 160, true)
	if err != nil {
		return User{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if assignedUsers(&s.data) >= s.entitlement.MaxAuthorizedUsers {
		return User{}, failure("seat_limit_reached", "All authorized user seats are assigned.")
	}
	now := s.now().UTC().Truncate(time.Second)
	user := User{UID: newUID("usr_"), Label: label, Access: "assigned", CreatedAt: now}
	next := clonePersisted(s.data)
	next.Users = append(next.Users, user)
	if err := s.commitLocked(next); err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *Store) SetOrganizationName(name string) error {
	name, err := cleanLabel(name, 100, false)
	if err != nil {
		return failure("invalid_organization_name", "The organization name must contain 1 to 100 characters.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := clonePersisted(s.data)
	next.OrgName = name
	return s.commitLocked(next)
}

func (s *Store) IssueEnrollmentCode(userUID string) (CodeResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.capacityViolationLocked(&s.data); err != nil {
		return CodeResult{}, err
	}
	user := userIn(&s.data, userUID)
	if user == nil {
		return CodeResult{}, failure("user_not_found", "The user was not found.")
	}
	if user.Access != "assigned" {
		return CodeResult{}, failure("user_deactivated", "The user is deactivated.")
	}
	if enrolledDevicesForUser(&s.data, userUID) >= s.entitlement.MaxDevicesPerUser {
		return CodeResult{}, failure("device_limit_reached", "This user has reached the enrolled device limit.")
	}
	now := s.now().UTC().Truncate(time.Second)
	next := clonePersisted(s.data)
	for index := range next.Codes {
		code := &next.Codes[index]
		if code.UserUID == userUID && code.RedeemedAt == nil && code.RevokedAt == nil && now.Before(code.ExpiresAt) {
			code.RevokedAt = timePointer(now)
		}
	}
	plain := "umbr_" + randomText(32)
	code := EnrollmentCode{
		UID: newUID("code_"), UserUID: userUID, Hash: hashSecret(plain),
		CreatedAt: now, ExpiresAt: now.Add(DefaultEnrollmentCodeTTL),
	}
	next.Codes = append(next.Codes, code)
	if err := s.commitLocked(next); err != nil {
		return CodeResult{}, err
	}
	return CodeResult{CodeUID: code.UID, EnrollmentCode: plain, ExpiresAt: code.ExpiresAt}, nil
}

func (s *Store) RevokeEnrollmentCode(codeUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC().Truncate(time.Second)
	next := clonePersisted(s.data)
	for index := range next.Codes {
		code := &next.Codes[index]
		if code.UID != codeUID {
			continue
		}
		if code.RedeemedAt != nil || code.RevokedAt != nil || !now.Before(code.ExpiresAt) {
			return failure("enrollment_code_not_pending", "The Enrollment code is not pending.")
		}
		code.RevokedAt = timePointer(now)
		return s.commitLocked(next)
	}
	return failure("enrollment_code_not_found", "The Enrollment code was not found.")
}

func (s *Store) DeactivateUser(userUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := userIn(&s.data, userUID)
	if current == nil {
		return failure("user_not_found", "The user was not found.")
	}
	if current.Access == "deactivated" {
		return nil
	}
	now := s.now().UTC().Truncate(time.Second)
	next := clonePersisted(s.data)
	userIn(&next, userUID).Access = "deactivated"
	for index := range next.Codes {
		code := &next.Codes[index]
		if code.UserUID == userUID && code.RedeemedAt == nil && code.RevokedAt == nil {
			code.RevokedAt = timePointer(now)
		}
	}
	for index := range next.Devices {
		device := &next.Devices[index]
		if device.UserUID == userUID && device.Access == "enrolled" {
			device.Access = "revoked"
			device.RevokedAt = timePointer(now)
		}
	}
	if err := s.commitLocked(next); err != nil {
		return err
	}
	s.removeEphemeralForUserLocked(userUID)
	return nil
}

func (s *Store) ReactivateUser(userUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := userIn(&s.data, userUID)
	if current == nil {
		return failure("user_not_found", "The user was not found.")
	}
	if current.Access == "assigned" {
		return nil
	}
	if assignedUsers(&s.data) >= s.entitlement.MaxAuthorizedUsers {
		return failure("seat_limit_reached", "All authorized user seats are assigned.")
	}
	next := clonePersisted(s.data)
	userIn(&next, userUID).Access = "assigned"
	return s.commitLocked(next)
}

func (s *Store) RevokeDevice(deviceUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := deviceIn(&s.data, deviceUID)
	if current == nil {
		return failure("device_not_found", "The device was not found.")
	}
	if current.Access == "revoked" {
		return nil
	}
	now := s.now().UTC().Truncate(time.Second)
	next := clonePersisted(s.data)
	device := deviceIn(&next, deviceUID)
	device.Access = "revoked"
	device.RevokedAt = timePointer(now)
	if err := s.commitLocked(next); err != nil {
		return err
	}
	s.removeEphemeralForDeviceLocked(deviceUID)
	return nil
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
	if err := s.capacityViolationLocked(&s.data); err != nil {
		return EnrollmentResult{}, err
	}
	now := s.now().UTC().Truncate(time.Second)
	providedHash := hashSecret(codeText)
	var currentCode *EnrollmentCode
	for index := range s.data.Codes {
		if constantTextEqual(s.data.Codes[index].Hash, providedHash) {
			currentCode = &s.data.Codes[index]
			break
		}
	}
	if currentCode == nil || currentCode.RevokedAt != nil || currentCode.RedeemedAt != nil {
		return EnrollmentResult{}, failure("enrollment_code_invalid", "The Enrollment code is invalid.")
	}
	if !now.Before(currentCode.ExpiresAt) {
		return EnrollmentResult{}, failure("enrollment_code_expired", "The Enrollment code has expired.")
	}
	user := userIn(&s.data, currentCode.UserUID)
	if user == nil || user.Access != "assigned" {
		return EnrollmentResult{}, failure("user_deactivated", "The user is deactivated.")
	}
	if enrolledDevicesForUser(&s.data, user.UID) >= s.entitlement.MaxDevicesPerUser {
		return EnrollmentResult{}, failure("device_limit_reached", "This user has reached the enrolled device limit.")
	}
	for _, device := range s.data.Devices {
		if device.PublicKey == publicKeyText {
			return EnrollmentResult{}, failure("device_already_enrolled", "This device key is already enrolled.")
		}
	}
	sum := sha256.Sum256(publicKey)
	device := Device{
		UID: newUID("dev_"), UserUID: user.UID, Label: deviceLabel,
		PublicKey: publicKeyText, Fingerprint: base64.RawURLEncoding.EncodeToString(sum[:9]),
		Access: "enrolled", EnrolledAt: now,
	}
	next := clonePersisted(s.data)
	for index := range next.Codes {
		if next.Codes[index].UID == currentCode.UID {
			next.Codes[index].RedeemedAt = timePointer(now)
			break
		}
	}
	next.Devices = append(next.Devices, device)
	if err := s.commitLocked(next); err != nil {
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
	s.pruneEphemeralLocked(now)
	if err := s.authorizeDeviceLocked(deviceUID); err != nil {
		return ChallengeResult{}, err
	}
	for uid, challenge := range s.challenges {
		if challenge.DeviceUID == deviceUID {
			delete(s.challenges, uid)
		}
	}
	if len(s.challenges) >= maxActiveChallenges {
		return ChallengeResult{}, failure("challenge_capacity", "Try again later.")
	}
	challenge := Challenge{
		UID: newUID("chal_"), DeviceUID: deviceUID,
		Value:     "umbratic-device-session-v1." + deviceUID + "." + randomText(32),
		CreatedAt: now, ExpiresAt: now.Add(ChallengeTTL),
	}
	s.challenges[challenge.UID] = challenge
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
	s.pruneEphemeralLocked(now)
	challenge, ok := s.challenges[challengeUID]
	if !ok || !now.Before(challenge.ExpiresAt) {
		return SessionResult{}, failure("challenge_invalid", "The challenge is invalid or expired.")
	}
	delete(s.challenges, challengeUID)
	if err := s.authorizeDeviceLocked(challenge.DeviceUID); err != nil {
		return SessionResult{}, err
	}
	device := deviceIn(&s.data, challenge.DeviceUID)
	publicKey, decodeErr := base64.RawURLEncoding.DecodeString(device.PublicKey)
	if decodeErr != nil || len(publicKey) != ed25519.PublicKeySize ||
		!ed25519.Verify(ed25519.PublicKey(publicKey), []byte(challenge.Value), signature) {
		return SessionResult{}, failure("challenge_proof_invalid", "The device proof is invalid.")
	}
	for hash, session := range s.sessions {
		if session.DeviceUID == device.UID {
			delete(s.sessions, hash)
		}
	}
	if len(s.sessions) >= maxActiveSessions {
		return SessionResult{}, failure("session_capacity", "Try again later.")
	}
	plain := "umbs_" + randomText(32)
	session := Session{Hash: hashSecret(plain), DeviceUID: device.UID, CreatedAt: now, ExpiresAt: now.Add(SessionTTL)}
	s.sessions[session.Hash] = session
	return SessionResult{
		Token:       plain,
		ExpiresAt:   session.ExpiresAt,
		OrgName:     s.data.OrgName,
		UpdateToken: updatefeed.Token(s.entitlement.OrgUID, now),
	}, nil
}

// Authenticate resolves a session token to its device. It runs on every
// product request, so it takes only a read lock and never sweeps: expired
// entries are recognised by their deadline here and reclaimed by maybePrune.
func (s *Store) Authenticate(token string) (string, error) {
	now := s.now().UTC()
	s.maybePrune(now)
	hash := hashSecret(token)
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.sessions[hash]
	if !ok {
		return "", failure("session_invalid", "The session is invalid.")
	}
	if !now.Before(session.ExpiresAt) {
		return "", failure("session_expired", "The session has expired.")
	}
	if err := s.authorizeDeviceLocked(session.DeviceUID); err != nil {
		return "", err
	}
	return session.DeviceUID, nil
}

// UserUIDForDevice returns the owning user for an enrolled device.
func (s *Store) UserUIDForDevice(deviceUID string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.authorizeDeviceLocked(deviceUID); err != nil {
		return "", err
	}
	device := deviceIn(&s.data, deviceUID)
	return device.UserUID, nil
}

// Touch records device activity. Writes are damped to lastSeenWriteInterval,
// and the damping test runs under a read lock so the common no-op path does
// not serialise concurrent requests behind the write lock.
func (s *Store) Touch(deviceUID string) error {
	now := s.now().UTC().Truncate(time.Second)
	s.mu.RLock()
	err := s.authorizeDeviceLocked(deviceUID)
	fresh := err == nil && recentlySeen(deviceIn(&s.data, deviceUID), now)
	s.mu.RUnlock()
	if err != nil {
		return err
	}
	if fresh {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.authorizeDeviceLocked(deviceUID); err != nil {
		return err
	}
	if recentlySeen(deviceIn(&s.data, deviceUID), now) {
		return nil
	}
	next := clonePersisted(s.data)
	device := deviceIn(&next, deviceUID)
	user := userIn(&next, device.UserUID)
	device.LastSeenAt = timePointer(now)
	if user.LastSeenAt == nil || user.LastSeenAt.Before(now) {
		user.LastSeenAt = timePointer(now)
	}
	return s.commitLocked(next)
}

func (s *Store) Logout(token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, hashSecret(token))
	return nil
}

func (s *Store) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := s.now().UTC().Truncate(time.Second)
	snapshot := Snapshot{
		OrgUID: s.entitlement.OrgUID, OrgName: s.data.OrgName,
		MaxAuthorizedUsers: s.entitlement.MaxAuthorizedUsers,
		MaxDevicesPerUser:  s.entitlement.MaxDevicesPerUser, RefreshedAt: now,
	}
	snapshot.SeatsAssigned = assignedUsers(&s.data)
	snapshot.SeatsAvailable = max(0, s.entitlement.MaxAuthorizedUsers-snapshot.SeatsAssigned)
	for _, user := range s.data.Users {
		item := SnapshotUser{
			UID: user.UID, Label: user.Label, Access: user.Access,
			CreatedAt: user.CreatedAt, LastSeenAt: user.LastSeenAt,
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

func (s *Store) authorizeDeviceLocked(deviceUID string) error {
	if err := s.capacityViolationLocked(&s.data); err != nil {
		return err
	}
	device := deviceIn(&s.data, deviceUID)
	if device == nil || device.Access != "enrolled" {
		return failure("device_not_authorized", "The device is not authorized.")
	}
	user := userIn(&s.data, device.UserUID)
	if user == nil || user.Access != "assigned" {
		return failure("device_not_authorized", "The device is not authorized.")
	}
	return nil
}

func (s *Store) capacityViolationLocked(data *persisted) error {
	if assignedUsers(data) > s.entitlement.MaxAuthorizedUsers {
		return failure("entitlement_over_limit", "Company access is over its authorized user limit.")
	}
	for _, user := range data.Users {
		if user.Access == "assigned" &&
			enrolledDevicesForUser(data, user.UID) > s.entitlement.MaxDevicesPerUser {
			return failure("entitlement_over_limit", "Company access is over its device limit.")
		}
	}
	return nil
}

func assignedUsers(data *persisted) int {
	count := 0
	for _, user := range data.Users {
		if user.Access == "assigned" {
			count++
		}
	}
	return count
}

func enrolledDevicesForUser(data *persisted, userUID string) int {
	count := 0
	for _, device := range data.Devices {
		if device.UserUID == userUID && device.Access == "enrolled" {
			count++
		}
	}
	return count
}

func userIn(data *persisted, uid string) *User {
	for index := range data.Users {
		if data.Users[index].UID == uid {
			return &data.Users[index]
		}
	}
	return nil
}

func deviceIn(data *persisted, uid string) *Device {
	for index := range data.Devices {
		if data.Devices[index].UID == uid {
			return &data.Devices[index]
		}
	}
	return nil
}

func (s *Store) removeEphemeralForDeviceLocked(deviceUID string) {
	for uid, challenge := range s.challenges {
		if challenge.DeviceUID == deviceUID {
			delete(s.challenges, uid)
		}
	}
	for hash, session := range s.sessions {
		if session.DeviceUID == deviceUID {
			delete(s.sessions, hash)
		}
	}
}

func (s *Store) removeEphemeralForUserLocked(userUID string) {
	for _, device := range s.data.Devices {
		if device.UserUID == userUID {
			s.removeEphemeralForDeviceLocked(device.UID)
		}
	}
}

func recentlySeen(device *Device, now time.Time) bool {
	return device != nil && device.LastSeenAt != nil && now.Sub(*device.LastSeenAt) < lastSeenWriteInterval
}

// maybePrune sweeps expired challenges and sessions at most once per
// pruneInterval, keeping the sweep off the per-request path.
func (s *Store) maybePrune(now time.Time) {
	s.mu.RLock()
	due := now.Sub(s.lastPrune) >= pruneInterval
	s.mu.RUnlock()
	if !due {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.Sub(s.lastPrune) < pruneInterval {
		return
	}
	s.pruneEphemeralLocked(now)
}

func (s *Store) pruneEphemeralLocked(now time.Time) {
	s.lastPrune = now
	for uid, challenge := range s.challenges {
		if !now.Before(challenge.ExpiresAt) {
			delete(s.challenges, uid)
		}
	}
	for hash, session := range s.sessions {
		if !now.Before(session.ExpiresAt) {
			delete(s.sessions, hash)
		}
	}
}

func clonePersisted(data persisted) persisted {
	next := data
	next.Users = append([]User(nil), data.Users...)
	next.Devices = append([]Device(nil), data.Devices...)
	next.Codes = append([]EnrollmentCode(nil), data.Codes...)
	return next
}

func (s *Store) commitLocked(next persisted) error {
	if err := persistData(s.path, next); err != nil {
		return err
	}
	s.data = next
	return nil
}

func persistData(path string, data persisted) error {
	payload, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("write identity store: %w", err)
	}
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := file.Write(payload); err != nil {
		return fmt.Errorf("write identity store: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync identity store: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close identity store: %w", err)
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("replace identity store: %w", err)
	}
	ok = true
	if directory, openErr := os.Open(filepath.Dir(path)); openErr == nil {
		_ = directory.Sync()
		_ = directory.Close()
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
