package web

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"umbratic-veil-console/internal/access"
)

type accessView struct {
	Available          bool
	OrgName            string
	SeatsAssigned      int
	SeatsAvailable     int
	MaxAuthorizedUsers int
	DevicesEnrolled    int
	MaxDevicesPerUser  int
	LastRefreshed      string
	FailedRefresh      string
	Filter             string
	AddUserDisabled    bool
	Users              []accessUserView
}

type accessUserView struct {
	UID                string
	Label              string
	StatusLabel        string
	LastSeenRelative   string
	LastSeenExact      string
	EnrolledDevices    int
	DevicesAvailable   int
	MaxDevicesPerUser  int
	EnrollmentCode     accessCodeView
	Devices            []accessDeviceView
	Deactivated        bool
	Expired            bool
	AwaitingEnrollment bool
	CanManageDevices   bool
}

type accessCodeView struct {
	UID       string
	ExpiresAt string
	Target    string
	Pending   bool
}

type accessDeviceView struct {
	UID              string
	Label            string
	LastSeenRelative string
	LastSeenExact    string
}

func (s *Server) accessPage(w http.ResponseWriter, r *http.Request) {
	data, err := s.accessData(r, r.URL.Query().Get("filter"))
	if err != nil {
		data.Error = ""
		s.renderStatus(w, "access.html", http.StatusServiceUnavailable, data)
		return
	}
	s.render(w, "access.html", data)
}

func (s *Server) accessData(r *http.Request, filter string) (pageData, error) {
	filter = normalizeAccessFilter(filter)
	_, configured, _ := s.store.Configuration(r.Context(), "current")
	processStatus := s.supervisor.Status()
	data := pageData{
		Title: "Management", CSRF: csrfCookie(r), Configured: configured, Running: processStatus.Running,
		EnterpriseEnabled: s.startup.EntitlementPath != "",
		Access:            accessView{Filter: filter},
		ActiveForOptions:  []int{30, 90, 180, 365},
	}
	if !data.EnterpriseEnabled || !data.Configured || !data.Running {
		return data, nil
	}
	snapshot, err := s.access.Snapshot(r.Context())
	if err != nil {
		data.Access.FailedRefresh = formatExactTime(time.Now())
		return data, err
	}
	data.Access = makeAccessView(snapshot, filter, time.Now())
	return data, nil
}

func (s *Server) accessOrganization(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.FormValue("name"))
	if err := s.access.SetOrganizationName(r.Context(), name); err != nil {
		s.store.Audit(r.Context(), "access.organization.update", "failure", time.Now())
		s.renderAccessMutationError(w, r, accessStatus(err), err.Error())
		return
	}
	s.store.Audit(r.Context(), "access.organization.update", "success", time.Now())
	http.Redirect(w, r, "/access", http.StatusSeeOther)
}

func (s *Server) accessCreateUser(w http.ResponseWriter, r *http.Request) {
	activeForDays, err := strconv.Atoi(strings.TrimSpace(r.FormValue("active_for_days")))
	if err != nil || !validActiveForDays(activeForDays) {
		s.renderAccessMutationError(w, r, http.StatusBadRequest, "Select 30, 90, 180, or 365 days.")
		return
	}
	user, err := s.access.CreateUser(r.Context(), strings.TrimSpace(r.FormValue("label")), activeForDays)
	if err != nil {
		s.store.Audit(r.Context(), "access.user.create", "failure", time.Now())
		s.renderAccessMutationError(w, r, accessStatus(err), err.Error())
		return
	}
	s.store.Audit(r.Context(), "access.user.create", "success", time.Now())
	code, err := s.access.IssueEnrollmentCode(r.Context(), user.UID)
	if err != nil {
		s.store.Audit(r.Context(), "access.enrollment_code.issue", "failure", time.Now())
		s.renderAccessMutationError(w, r, accessStatus(err), "The user was created, but the Enrollment code could not be issued.")
		return
	}
	s.store.Audit(r.Context(), "access.enrollment_code.issue", "success", time.Now())
	s.render(w, "enrollment-code-created.html", pageData{
		Title: "Enrollment code", CSRF: csrfCookie(r),
		EnrollmentCode: code.EnrollmentCode, EnrollmentExpires: formatExactTime(code.ExpiresAt),
	})
}

func (s *Server) accessDeactivateUser(w http.ResponseWriter, r *http.Request) {
	if r.FormValue("confirm") != "yes" {
		s.renderAccessMutationError(w, r, http.StatusBadRequest, "Confirm that you want to deactivate this user.")
		return
	}
	s.runAccessMutation(w, r, "access.user.deactivate", func() error {
		return s.access.DeactivateUser(r.Context(), r.PathValue("user_uid"))
	})
}

func (s *Server) accessReactivateUser(w http.ResponseWriter, r *http.Request) {
	s.runAccessMutation(w, r, "access.user.reactivate", func() error {
		return s.access.ReactivateUser(r.Context(), r.PathValue("user_uid"))
	})
}

func (s *Server) accessIssueCode(w http.ResponseWriter, r *http.Request) {
	code, err := s.access.IssueEnrollmentCode(r.Context(), r.PathValue("user_uid"))
	if err != nil {
		s.store.Audit(r.Context(), "access.enrollment_code.issue", "failure", time.Now())
		s.renderAccessMutationError(w, r, accessStatus(err), err.Error())
		return
	}
	s.store.Audit(r.Context(), "access.enrollment_code.issue", "success", time.Now())
	s.render(w, "enrollment-code-created.html", pageData{
		Title: "Enrollment code", CSRF: csrfCookie(r),
		EnrollmentCode: code.EnrollmentCode, EnrollmentExpires: formatExactTime(code.ExpiresAt),
	})
}

func (s *Server) accessRevokeCode(w http.ResponseWriter, r *http.Request) {
	s.runAccessMutation(w, r, "access.enrollment_code.revoke", func() error {
		return s.access.RevokeEnrollmentCode(r.Context(), r.PathValue("code_uid"))
	})
}

func (s *Server) accessRevokeDevice(w http.ResponseWriter, r *http.Request) {
	if r.FormValue("confirm") != "yes" {
		s.renderAccessMutationError(w, r, http.StatusBadRequest, "Confirm that you want to revoke this device.")
		return
	}
	s.runAccessMutation(w, r, "access.device.revoke", func() error {
		return s.access.RevokeDevice(r.Context(), r.PathValue("device_uid"))
	})
}

func (s *Server) runAccessMutation(w http.ResponseWriter, r *http.Request, event string, action func() error) {
	if err := action(); err != nil {
		s.store.Audit(r.Context(), event, "failure", time.Now())
		s.renderAccessMutationError(w, r, accessStatus(err), err.Error())
		return
	}
	s.store.Audit(r.Context(), event, "success", time.Now())
	http.Redirect(w, r, "/access", http.StatusSeeOther)
}

func (s *Server) renderAccessMutationError(w http.ResponseWriter, r *http.Request, status int, message string) {
	data, _ := s.accessData(r, r.URL.Query().Get("filter"))
	data.Error = message
	s.renderStatus(w, "access.html", status, data)
}

func accessStatus(err error) int {
	var clientError *access.Error
	if errors.As(err, &clientError) && clientError.Status >= 400 && clientError.Status <= 599 {
		return clientError.Status
	}
	return http.StatusServiceUnavailable
}

func normalizeAccessFilter(value string) string {
	switch value {
	case "awaiting", "expired", "deactivated":
		return value
	default:
		return "all"
	}
}

func makeAccessView(snapshot access.Snapshot, filter string, now time.Time) accessView {
	view := accessView{
		Available: true, OrgName: snapshot.OrgName,
		SeatsAssigned: snapshot.SeatsAssigned, SeatsAvailable: snapshot.SeatsAvailable,
		MaxAuthorizedUsers: snapshot.MaxAuthorizedUsers, DevicesEnrolled: snapshot.DevicesEnrolled,
		MaxDevicesPerUser: snapshot.MaxDevicesPerUser, LastRefreshed: formatExactTime(snapshot.RefreshedAt),
		Filter: filter, AddUserDisabled: snapshot.SeatsAssigned >= snapshot.MaxAuthorizedUsers,
	}
	for _, user := range snapshot.Users {
		item := accessUserView{
			UID: user.UID, Label: user.Label,
			LastSeenRelative: relativeTime(user.LastSeenAt, now), LastSeenExact: exactOptionalTime(user.LastSeenAt),
			EnrolledDevices: user.EnrolledDevices, MaxDevicesPerUser: snapshot.MaxDevicesPerUser,
			Deactivated: user.Access == "deactivated", Expired: user.Access == "expired",
			AwaitingEnrollment: user.Access == "assigned" && user.EnrolledDevices == 0,
			CanManageDevices:   user.Access == "assigned",
		}
		if item.Label == "" {
			item.Label = "Unnamed user"
		}
		item.DevicesAvailable = max(0, snapshot.MaxDevicesPerUser-user.EnrolledDevices)
		switch {
		case item.Deactivated:
			item.StatusLabel = "Deactivated"
		case item.Expired:
			item.StatusLabel = "Expired"
		case item.AwaitingEnrollment:
			item.StatusLabel = "Needs setup"
		}
		for index := len(user.EnrollmentCodes) - 1; index >= 0; index-- {
			code := user.EnrollmentCodes[index]
			if code.Status == "pending" {
				item.EnrollmentCode = accessCodeView{
					UID: code.UID, ExpiresAt: formatExactTime(code.ExpiresAt),
					Target: ordinal(user.EnrolledDevices + 1), Pending: true,
				}
				break
			}
		}
		for _, device := range user.Devices {
			if device.Access != "enrolled" {
				continue
			}
			item.Devices = append(item.Devices, accessDeviceView{
				UID: device.UID, Label: device.Label,
				LastSeenRelative: relativeTime(device.LastSeenAt, now), LastSeenExact: exactOptionalTime(device.LastSeenAt),
			})
		}
		if accessFilterMatches(item, filter) {
			view.Users = append(view.Users, item)
		}
	}
	return view
}

func accessFilterMatches(user accessUserView, filter string) bool {
	switch filter {
	case "awaiting":
		return user.AwaitingEnrollment
	case "expired":
		return user.Expired
	case "deactivated":
		return user.Deactivated
	default:
		return true
	}
}

func relativeTime(value *time.Time, now time.Time) string {
	if value == nil {
		return "Never connected"
	}
	elapsed := now.Sub(*value)
	if elapsed < time.Minute {
		return "Last seen just now"
	}
	if elapsed < time.Hour {
		return fmt.Sprintf("Last seen %dm ago", int(elapsed/time.Minute))
	}
	if elapsed < 24*time.Hour {
		return fmt.Sprintf("Last seen %dh ago", int(elapsed/time.Hour))
	}
	return fmt.Sprintf("Last seen %dd ago", int(elapsed/(24*time.Hour)))
}

func validActiveForDays(days int) bool {
	return days == 30 || days == 90 || days == 180 || days == 365
}

func ordinal(value int) string {
	suffix := "th"
	if value%100 < 11 || value%100 > 13 {
		switch value % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return fmt.Sprintf("%d%s", value, suffix)
}

func exactOptionalTime(value *time.Time) string {
	if value == nil {
		return "Never"
	}
	return formatExactTime(*value)
}

func formatExactTime(value time.Time) string {
	return value.UTC().Format("2006-01-02 15:04 UTC")
}

func titleStatus(value string) string {
	if value == "" {
		return ""
	}
	return strings.ToUpper(value[:1]) + strings.ReplaceAll(value[1:], "_", " ")
}

func shortUID(value string) string {
	if len(value) <= 13 {
		return value
	}
	return value[:4] + "…" + value[len(value)-5:]
}
