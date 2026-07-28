package web

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"umbratic-veil-console/internal/access"
)

func TestManagementExplainsEnterpriseDeploymentRequirement(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	response := httptest.NewRecorder()
	server.render(response, "access.html", pageData{Title: "Management"})
	body := response.Body.String()
	if !strings.Contains(body, "<h1>Management</h1>") ||
		!strings.Contains(body, "Deploy Enterprise Veil") ||
		strings.Contains(body, "Refresh activity") {
		t.Fatalf("management deployment state is unclear: %s", body)
	}
}

func TestAccessViewShowsOnlyUsefulCurrentDeviceState(t *testing.T) {
	now := time.Date(2026, 7, 27, 18, 0, 0, 0, time.UTC)
	recent := now.Add(-2 * time.Minute)
	old := now.Add(-45 * 24 * time.Hour)
	snapshot := access.Snapshot{
		OrgUID: "org_customerlicense", OrgName: "Northwind", MaxAuthorizedUsers: 3, MaxDevicesPerUser: 2,
		SeatsAssigned: 2, SeatsAvailable: 1, DevicesEnrolled: 1, RefreshedAt: now,
		Users: []access.User{
			{
				UID: "usr_alice123456", Label: "Alice", Access: "assigned",
				LastSeenAt: &recent, EnrolledDevices: 1,
				EnrollmentCodes: []access.Code{
					{UID: "code_one", Status: "redeemed", CreatedAt: now, ExpiresAt: now},
					{UID: "code_two", Status: "pending", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)},
				},
				Devices: []access.Device{
					{UID: "dev_current", Label: "Work laptop", Fingerprint: "fingerprint", Access: "enrolled", EnrolledAt: now, LastSeenAt: &recent},
					{UID: "dev_old", Label: "Old laptop", Fingerprint: "old", Access: "revoked", EnrolledAt: old, RevokedAt: &old, LastSeenAt: &old},
				},
			},
			{UID: "usr_bob12345678", Label: "Bob", Access: "assigned", EnrolledDevices: 0},
			{UID: "usr_expired1234", Label: "Expired user", Access: "expired", ActiveForDays: 30, ExpiresAt: old},
			{UID: "usr_old12345678", Label: "Former user", Access: "deactivated", LastSeenAt: &old},
		},
	}
	view := makeAccessView(snapshot, "all", now)
	if !view.Available || view.OrgName != "Northwind" || view.SeatsAssigned != 2 || view.DevicesEnrolled != 1 || len(view.Users) != 4 {
		t.Fatalf("capacity or history was lost: %#v", view)
	}
	if len(view.Users[0].Devices) != 1 || !view.Users[0].EnrollmentCode.Pending ||
		view.Users[0].EnrollmentCode.Target != "2nd" || view.Users[0].DevicesAvailable != 1 {
		t.Fatalf("current device or Enrollment code state is wrong: %#v", view.Users[0])
	}
	if !view.Users[1].AwaitingEnrollment || view.Users[1].StatusLabel != "Needs setup" {
		t.Fatalf("assigned user without a device was not awaiting enrollment: %#v", view.Users[1])
	}
	if filtered := makeAccessView(snapshot, "deactivated", now); len(filtered.Users) != 1 || !filtered.Users[0].Deactivated {
		t.Fatalf("deactivated filter failed: %#v", filtered.Users)
	}
	if expired := makeAccessView(snapshot, "expired", now); len(expired.Users) != 1 || !expired.Users[0].Expired {
		t.Fatal("expired filter failed")
	}

	server, closeServer := testServer(t)
	defer closeServer()
	response := httptest.NewRecorder()
	server.render(response, "access.html", pageData{
		Title: "Management", CSRF: "token", EnterpriseEnabled: true, Configured: true, Running: true,
		Access: view, ActiveForOptions: []int{30, 90, 180, 365},
	})
	body := response.Body.String()
	for _, expected := range []string{
		"Northwind", "Active for", "Issued for 2nd device",
		"Revoke code and generate a new one", "1 of 2 devices",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("management page is missing %q: %s", expected, body)
		}
	}
	if strings.Contains(body, "Fingerprint") || strings.Contains(body, "Enrolled 2026") ||
		strings.Contains(body, `<details class="panel access-user" open>`) {
		t.Fatalf("management page contains hidden implementation data or opens every row: %s", body)
	}
}

func TestOrdinal(t *testing.T) {
	for value, expected := range map[int]string{
		1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 11: "11th", 12: "12th", 13: "13th", 21: "21st",
	} {
		if actual := ordinal(value); actual != expected {
			t.Fatalf("ordinal(%d) = %q, want %q", value, actual, expected)
		}
	}
}
