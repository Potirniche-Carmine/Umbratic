package access

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

type Snapshot struct {
	OrgUID             string    `json:"org_uid"`
	OrgName            string    `json:"org_name"`
	MaxAuthorizedUsers int       `json:"max_authorized_users"`
	MaxDevicesPerUser  int       `json:"max_devices_per_user"`
	SeatsAssigned      int       `json:"seats_assigned"`
	SeatsAvailable     int       `json:"seats_available"`
	DevicesEnrolled    int       `json:"devices_enrolled"`
	Users              []User    `json:"users"`
	RefreshedAt        time.Time `json:"refreshed_at"`
}

type User struct {
	UID             string     `json:"uid"`
	Label           string     `json:"label"`
	Access          string     `json:"access"`
	ActiveForDays   int        `json:"active_for_days"`
	CreatedAt       time.Time  `json:"created_at"`
	ExpiresAt       time.Time  `json:"expires_at"`
	LastSeenAt      *time.Time `json:"last_seen_at"`
	EnrollmentCodes []Code     `json:"enrollment_codes"`
	Devices         []Device   `json:"devices"`
	EnrolledDevices int        `json:"enrolled_devices"`
}

type Code struct {
	UID        string     `json:"uid"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	RedeemedAt *time.Time `json:"redeemed_at"`
}

type Device struct {
	UID         string     `json:"uid"`
	Label       string     `json:"label"`
	Fingerprint string     `json:"fingerprint"`
	Access      string     `json:"access"`
	EnrolledAt  time.Time  `json:"enrolled_at"`
	RevokedAt   *time.Time `json:"revoked_at"`
	LastSeenAt  *time.Time `json:"last_seen_at"`
}

type CreatedUser struct {
	UID   string `json:"uid"`
	Label string `json:"label"`
}

type EnrollmentCode struct {
	CodeUID        string    `json:"code_uid"`
	EnrollmentCode string    `json:"enrollment_code"`
	ExpiresAt      time.Time `json:"expires_at"`
}

type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func NewClient(address, token string) *Client {
	return &Client{
		baseURL: "http://" + address,
		token:   token,
		http:    &http.Client{Timeout: 6 * time.Second},
	}
}

func (c *Client) Snapshot(ctx context.Context) (Snapshot, error) {
	var result Snapshot
	err := c.do(ctx, http.MethodGet, "/api/control/access", nil, &result)
	return result, err
}

func (c *Client) CreateUser(ctx context.Context, label string, activeForDays int) (CreatedUser, error) {
	var result CreatedUser
	err := c.do(ctx, http.MethodPost, "/api/control/users", map[string]any{
		"label": label, "active_for_days": activeForDays,
	}, &result)
	return result, err
}

func (c *Client) SetOrganizationName(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodPost, "/api/control/organization", map[string]string{"name": name}, nil)
}

func (c *Client) IssueEnrollmentCode(ctx context.Context, userUID string) (EnrollmentCode, error) {
	var result EnrollmentCode
	err := c.do(ctx, http.MethodPost, "/api/control/users/"+url.PathEscape(userUID)+"/enrollment-codes", map[string]any{}, &result)
	return result, err
}

func (c *Client) DeactivateUser(ctx context.Context, userUID string) error {
	return c.mutate(ctx, "/api/control/users/"+url.PathEscape(userUID)+"/deactivate")
}

func (c *Client) ReactivateUser(ctx context.Context, userUID string) error {
	return c.mutate(ctx, "/api/control/users/"+url.PathEscape(userUID)+"/reactivate")
}

func (c *Client) RevokeEnrollmentCode(ctx context.Context, codeUID string) error {
	return c.mutate(ctx, "/api/control/enrollment-codes/"+url.PathEscape(codeUID)+"/revoke")
}

func (c *Client) RevokeDevice(ctx context.Context, deviceUID string) error {
	return c.mutate(ctx, "/api/control/devices/"+url.PathEscape(deviceUID)+"/revoke")
}

func (c *Client) mutate(ctx context.Context, path string) error {
	return c.do(ctx, http.MethodPost, path, map[string]any{}, nil)
}

func (c *Client) do(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		payload, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return errors.New("Access data is unavailable.")
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return errors.New("Access data is unavailable.")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var value struct {
			Code  string `json:"code"`
			Error string `json:"error"`
		}
		_ = json.Unmarshal(payload, &value)
		message := strings.TrimSpace(value.Error)
		if message == "" {
			message = "The access change failed."
		}
		return &Error{Status: response.StatusCode, Code: value.Code, Message: message}
	}
	if output == nil {
		return nil
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return fmt.Errorf("Access data is invalid.")
	}
	return nil
}
