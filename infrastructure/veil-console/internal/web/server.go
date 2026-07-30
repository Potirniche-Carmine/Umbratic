package web

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"umbratic-veil-console/internal/access"
	"umbratic-veil-console/internal/auth"
	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/state"
	"umbratic-veil-console/internal/supervisor"
)

//go:embed templates/*.html assets/*.css assets/*.js assets/*.png assets/*.ico
var content embed.FS

type Server struct {
	startup      config.Startup
	store        *state.Store
	secretsMu    sync.RWMutex
	secrets      state.Secrets
	supervisor   *supervisor.Supervisor
	access       *access.Client
	templates    *template.Template
	throttle     *loginThrottle
	crossOrigin  *http.CrossOriginProtection
	restartMu    sync.Mutex
	restartAfter time.Time
}

const restartCooldown = 5 * time.Second

type pageData struct {
	Title             string
	CSRF              string
	Error             string
	Notice            string
	Username          string
	Setup             bool
	Configured        bool
	Status            string
	Config            config.Veil
	Token             string
	BodySizeIndex     int
	BodySizeLabel     string
	ContextIndex      int
	ContextLabel      string
	PasswordError     bool
	Running           bool
	Healthy           bool
	VeilURL           string
	EnterpriseEnabled bool
	Access            accessView
	Models            []string
	EnrollmentCode    string
	EnrollmentExpires string
	RetryAfterSeconds int
}

type contextKey int

const sessionKey contextKey = 1

type requestSession struct {
	Token string
	Data  state.Session
}

func New(startup config.Startup, store *state.Store, secrets state.Secrets, process *supervisor.Supervisor) (*Server, error) {
	templates, err := template.ParseFS(content, "templates/*.html")
	if err != nil {
		return nil, err
	}
	crossOrigin := http.NewCrossOriginProtection()
	port := strconv.Itoa(startup.Port)
	origins := []string{
		"http://" + net.JoinHostPort("127.0.0.1", port),
		"http://" + net.JoinHostPort("localhost", port),
		"http://" + net.JoinHostPort("::1", port),
	}
	if startup.TrustedOrigin != "" {
		origins = append(origins, startup.TrustedOrigin)
	}
	for _, origin := range origins {
		if err := crossOrigin.AddTrustedOrigin(origin); err != nil {
			return nil, fmt.Errorf("configure trusted origin: %w", err)
		}
	}
	crossOrigin.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "request origin is invalid", http.StatusForbidden)
	}))
	return &Server{
		startup: startup, store: store, secrets: secrets, supervisor: process,
		access:    access.NewClient(startup.VeilAddress, secrets.ControlToken),
		templates: templates, throttle: newLoginThrottle(), crossOrigin: crossOrigin,
	}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /assets/style.css", s.style)
	mux.HandleFunc("GET /assets/access.css", s.accessStyle)
	mux.HandleFunc("GET /assets/settings.css", s.settingsStyle)
	mux.HandleFunc("GET /assets/console.js", s.script)
	mux.HandleFunc("GET /assets/umbratic-icon.png", s.logo)
	mux.HandleFunc("GET /favicon.ico", s.favicon)
	mux.HandleFunc("GET /setup", s.setupPage)
	mux.HandleFunc("POST /setup", s.setupSubmit)
	mux.HandleFunc("GET /login", s.loginPage)
	mux.HandleFunc("POST /login", s.loginSubmit)
	mux.Handle("POST /logout", s.requireSession(http.HandlerFunc(s.logout)))
	mux.Handle("GET /session/touch", s.requireSession(http.HandlerFunc(s.sessionTouch)))
	mux.Handle("GET /", s.requireSession(http.HandlerFunc(s.dashboard)))
	mux.Handle("GET /settings", s.requireSession(http.HandlerFunc(s.settingsPage)))
	mux.Handle("POST /settings/test", s.requireSession(http.HandlerFunc(s.settingsTest)))
	mux.Handle("POST /settings/apply", s.requireSession(http.HandlerFunc(s.settingsApply)))
	mux.Handle("POST /veil/start", s.requireSession(http.HandlerFunc(s.veilStart)))
	mux.Handle("POST /veil/stop", s.requireSession(http.HandlerFunc(s.veilStop)))
	mux.Handle("POST /veil/restart", s.requireSession(http.HandlerFunc(s.veilRestart)))
	mux.Handle("GET /access", s.requireSession(http.HandlerFunc(s.accessPage)))
	mux.Handle("POST /access/organization", s.requireSession(http.HandlerFunc(s.accessOrganization)))
	mux.Handle("POST /access/users", s.requireSession(http.HandlerFunc(s.accessCreateUser)))
	mux.Handle("POST /access/users/{user_uid}/deactivate", s.requireSession(http.HandlerFunc(s.accessDeactivateUser)))
	mux.Handle("POST /access/users/{user_uid}/reactivate", s.requireSession(http.HandlerFunc(s.accessReactivateUser)))
	mux.Handle("POST /access/users/{user_uid}/enrollment-codes", s.requireSession(http.HandlerFunc(s.accessIssueCode)))
	mux.Handle("POST /access/enrollment-codes/{code_uid}/revoke", s.requireSession(http.HandlerFunc(s.accessRevokeCode)))
	mux.Handle("POST /access/devices/{device_uid}/revoke", s.requireSession(http.HandlerFunc(s.accessRevokeDevice)))
	mux.HandleFunc("/", s.redirectHome)
	return s.securityHeaders(s.validateHost(s.crossOrigin.Handler(mux)))
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		if r.URL.Path != "/healthz" && r.URL.Path != "/assets/style.css" &&
			r.URL.Path != "/assets/access.css" && r.URL.Path != "/assets/settings.css" {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) validateHost(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	port := strconv.Itoa(s.startup.Port)
	for _, host := range []string{net.JoinHostPort(s.startup.Listen, port), net.JoinHostPort("127.0.0.1", port), net.JoinHostPort("::1", port), net.JoinHostPort("localhost", port)} {
		allowed[strings.ToLower(host)] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[strings.ToLower(r.Host)] {
			http.Error(w, "invalid request host", http.StatusBadRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("veil_console_session")
		if err != nil {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		session, err := s.store.Session(r.Context(), cookie.Value, time.Now())
		if err != nil {
			s.clearSessionCookies(w)
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		if r.Method == http.MethodPost {
			if err := s.validateFormRequest(w, r); err != nil {
				http.Error(w, err.Error(), http.StatusForbidden)
				return
			}
			csrfCookie, err := r.Cookie("veil_console_csrf")
			if err != nil || subtle.ConstantTimeCompare(auth.HashToken(r.FormValue("csrf")), session.CSRFHash) != 1 || subtle.ConstantTimeCompare([]byte(r.FormValue("csrf")), []byte(csrfCookie.Value)) != 1 {
				http.Error(w, "request verification failed", http.StatusForbidden)
				return
			}
		}
		ctx := context.WithValue(r.Context(), sessionKey, requestSession{Token: cookie.Value, Data: session})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) validateFormRequest(w http.ResponseWriter, r *http.Request) error {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/x-www-form-urlencoded") {
		return errors.New("form content type is required")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		return errors.New("form is invalid or too large")
	}
	return nil
}

func (s *Server) publicCSRF(w http.ResponseWriter, r *http.Request) string {
	if cookie, err := r.Cookie("veil_console_public_csrf"); err == nil && s.verifySignedToken(cookie.Value) {
		return cookie.Value
	}
	plain, _, err := auth.NewToken()
	if err != nil {
		return ""
	}
	signed := plain + "." + s.sign(plain)
	http.SetCookie(w, &http.Cookie{
		Name: "veil_console_public_csrf", Value: signed, Path: "/", HttpOnly: true,
		Secure: s.startup.TrustedOrigin != "", SameSite: http.SameSiteStrictMode, MaxAge: 900,
	})
	return signed
}

func (s *Server) sign(value string) string {
	s.secretsMu.RLock()
	key := s.secrets.CSRFKey
	s.secretsMu.RUnlock()
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = io.WriteString(mac, value)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Server) verifySignedToken(value string) bool {
	plain, signature, ok := strings.Cut(value, ".")
	return ok && hmac.Equal([]byte(s.sign(plain)), []byte(signature))
}

func (s *Server) validatePublicPost(w http.ResponseWriter, r *http.Request) bool {
	if err := s.validateFormRequest(w, r); err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return false
	}
	cookie, err := r.Cookie("veil_console_public_csrf")
	if err != nil || !s.verifySignedToken(cookie.Value) || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(r.FormValue("csrf"))) != 1 {
		http.Error(w, "request verification failed", http.StatusForbidden)
		return false
	}
	return true
}

func (s *Server) setupPage(w http.ResponseWriter, r *http.Request) {
	setup, _ := s.store.IsSetup(r.Context())
	if setup {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	csrf := s.publicCSRF(w, r)
	if csrf == "" {
		s.renderStatus(w, "setup.html", http.StatusInternalServerError, pageData{Title: "Create owner", Error: "Setup is temporarily unavailable."})
		return
	}
	s.render(w, "setup.html", pageData{Title: "Create owner", CSRF: csrf})
}

func (s *Server) setupSubmit(w http.ResponseWriter, r *http.Request) {
	if !s.validatePublicPost(w, r) {
		return
	}
	verifier, err := auth.HashPassword(r.FormValue("password"))
	if err == nil {
		err = s.store.CreateOwner(r.Context(), r.FormValue("setup_code"), strings.TrimSpace(r.FormValue("username")), verifier, time.Now())
	}
	if err != nil {
		s.renderStatus(w, "setup.html", http.StatusBadRequest, pageData{Title: "Create owner", CSRF: r.FormValue("csrf"), Error: err.Error()})
		return
	}
	if os.Getenv("INVOCATION_ID") != "" {
		_ = os.Remove("/run/veil-console/setup-code")
	}
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (s *Server) loginPage(w http.ResponseWriter, r *http.Request) {
	setup, _ := s.store.IsSetup(r.Context())
	if !setup {
		http.Redirect(w, r, "/setup", http.StatusSeeOther)
		return
	}
	csrf := s.publicCSRF(w, r)
	if csrf == "" {
		s.renderStatus(w, "login.html", http.StatusInternalServerError, pageData{Title: "Sign in", Error: "Sign in is temporarily unavailable."})
		return
	}
	s.render(w, "login.html", pageData{Title: "Sign in", CSRF: csrf})
}

func (s *Server) loginSubmit(w http.ResponseWriter, r *http.Request) {
	if !s.validatePublicPost(w, r) {
		return
	}
	username := strings.TrimSpace(r.FormValue("username"))
	usernameKey := "username|" + username
	sourceKey := "source|" + remoteIP(r.RemoteAddr)
	if wait := max(s.throttle.Wait(usernameKey, time.Now()), s.throttle.Wait(sourceKey, time.Now())); wait > 0 {
		seconds := retryAfterSeconds(wait)
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		s.renderStatus(w, "login.html", http.StatusTooManyRequests, pageData{
			Title: "Sign in", CSRF: r.FormValue("csrf"), Error: "Sign in failed. Try again later.", RetryAfterSeconds: seconds,
		})
		return
	}
	if !s.store.VerifyOwner(r.Context(), username, r.FormValue("password")) {
		now := time.Now()
		s.throttle.Failed(usernameKey, now)
		s.throttle.Failed(sourceKey, now)
		seconds := retryAfterSeconds(max(s.throttle.Wait(usernameKey, now), s.throttle.Wait(sourceKey, now)))
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		s.store.Audit(r.Context(), "login", "failure", time.Now())
		s.renderStatus(w, "login.html", http.StatusUnauthorized, pageData{
			Title: "Sign in", CSRF: r.FormValue("csrf"), Error: "Username or password is incorrect.", RetryAfterSeconds: seconds,
		})
		return
	}
	s.throttle.Success(usernameKey)
	s.throttle.Success(sourceKey)
	token, csrf, err := s.store.CreateSession(r.Context(), username, time.Now())
	if err != nil {
		s.renderStatus(w, "login.html", http.StatusInternalServerError, pageData{Title: "Sign in", CSRF: r.FormValue("csrf"), Error: "Sign in failed. Try again."})
		return
	}
	s.setSessionCookies(w, token, csrf)
	s.store.Audit(r.Context(), "login", "success", time.Now())
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	session := r.Context().Value(sessionKey).(requestSession)
	_ = s.store.RevokeSession(r.Context(), session.Token)
	s.clearSessionCookies(w)
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (s *Server) redirectHome(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) sessionTouch(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		s.redirectHome(w, r)
		return
	}
	s.render(w, "dashboard.html", s.dashboardData(r, "", ""))
}

func (s *Server) dashboardData(r *http.Request, errorMessage, noticeMessage string) pageData {
	session := r.Context().Value(sessionKey).(requestSession)
	_, configured, _ := s.store.Configuration(r.Context(), "current")
	processStatus := s.supervisor.Status()
	return pageData{
		Title: "Veil Console", CSRF: csrfCookie(r), Username: session.Data.Username,
		Configured: configured, Status: processStatus.String(), Running: processStatus.Running, Healthy: processStatus.Healthy,
		VeilURL: "http://" + s.startup.VeilAddress,
		Error:   errorMessage, Notice: noticeMessage,
	}
}

func (s *Server) settingsPage(w http.ResponseWriter, r *http.Request) {
	cfg, ok, err := s.store.Configuration(r.Context(), "current")
	if err != nil {
		s.renderStatus(w, "settings.html", http.StatusInternalServerError, s.settingsData(r, config.DefaultVeil(), "Settings could not be loaded.", ""))
		return
	}
	if !ok {
		cfg = config.DefaultVeil()
		cfg.Protocol = "ollama"
		cfg.ProviderBaseURL = "http://127.0.0.1:11434"
		cfg.ContextLength = 65536
	}
	s.render(w, "settings.html", s.settingsData(r, cfg, "", ""))
}

func (s *Server) settingsData(r *http.Request, cfg config.Veil, errorMessage, noticeMessage string) pageData {
	return pageData{
		Title: "Settings", CSRF: csrfCookie(r), Config: cfg,
		Error: errorMessage, Notice: noticeMessage, Models: settingsModels(r.Context(), cfg),
	}
}

func (s *Server) settingsTest(w http.ResponseWriter, r *http.Request) {
	cfg, _ := parseSettings(r)
	if err := s.freshPassword(w, r); err != nil {
		status := http.StatusInternalServerError
		data := s.settingsData(r, cfg, "Password confirmation failed. Try again.", "")
		if errors.Is(err, errPasswordConfirmation) {
			status = http.StatusUnauthorized
			data.Error = ""
			data.PasswordError = true
		}
		s.renderStatus(w, "settings.html", status, data)
		return
	}
	cfg, err := parseSettings(r)
	if err == nil {
		err = supervisor.TestProvider(r.Context(), cfg)
	}
	if err != nil {
		s.renderStatus(w, "settings.html", http.StatusBadRequest, s.settingsData(r, cfg, err.Error(), ""))
		return
	}
	s.render(w, "settings.html", s.settingsData(r, cfg, "", "Connection successful."))
}

func (s *Server) settingsApply(w http.ResponseWriter, r *http.Request) {
	cfg, _ := parseSettings(r)
	if err := s.freshPassword(w, r); err != nil {
		status := http.StatusInternalServerError
		data := s.settingsData(r, cfg, "Password confirmation failed. Try again.", "")
		if errors.Is(err, errPasswordConfirmation) {
			status = http.StatusUnauthorized
			data.Error = ""
			data.PasswordError = true
		}
		s.renderStatus(w, "settings.html", status, data)
		return
	}
	cfg, err := parseSettings(r)
	secrets := s.currentSecrets()
	if err != nil {
		s.store.Audit(r.Context(), "settings.apply", "failure", time.Now())
		s.renderStatus(w, "settings.html", http.StatusBadRequest, s.settingsData(r, cfg, err.Error(), ""))
		return
	}
	if err := supervisor.TestProvider(r.Context(), cfg); err != nil {
		s.store.Audit(r.Context(), "settings.apply", "failure", time.Now())
		s.renderStatus(w, "settings.html", http.StatusBadRequest, s.settingsData(r, cfg, err.Error(), ""))
		return
	}
	if err := s.store.SavePending(r.Context(), cfg, time.Now()); err != nil {
		s.store.Audit(r.Context(), "settings.apply", "failure", time.Now())
		s.renderStatus(w, "settings.html", http.StatusInternalServerError, s.settingsData(r, cfg, "Changes could not be saved.", ""))
		return
	}
	previous, exists, err := s.store.Configuration(r.Context(), "current")
	if err != nil {
		_ = s.store.DiscardPending(r.Context())
		s.store.Audit(r.Context(), "settings.apply", "failure", time.Now())
		s.renderStatus(w, "settings.html", http.StatusInternalServerError, s.settingsData(r, cfg, "The active configuration could not be read.", ""))
		return
	}
	var previousPointer *config.Veil
	if exists {
		previousPointer = &previous
	}
	if err := s.supervisor.Apply(r.Context(), cfg, previousPointer, secrets.ControlToken); err != nil {
		_ = s.store.DiscardPending(r.Context())
		s.store.Audit(r.Context(), "settings.apply", "failure", time.Now())
		s.renderStatus(w, "settings.html", statusFor(err), s.settingsData(r, cfg, err.Error(), ""))
		return
	}
	err = s.store.PromotePending(r.Context(), time.Now())
	if err != nil {
		if exists {
			_ = s.supervisor.Restart(context.Background(), previous, secrets.ControlToken)
		} else {
			_ = s.supervisor.Stop(context.Background())
		}
		_ = s.store.DiscardPending(r.Context())
		s.store.Audit(r.Context(), "settings.apply", "failure", time.Now())
		s.renderStatus(w, "settings.html", http.StatusInternalServerError, s.settingsData(
			r,
			cfg,
			"Settings could not be committed. The last active configuration was restored.",
			"",
		))
		return
	}
	http.Redirect(w, r, "/access", http.StatusSeeOther)
}

func (s *Server) veilStart(w http.ResponseWriter, r *http.Request) {
	if s.supervisor.Status().Running {
		s.render(w, "dashboard.html", s.dashboardData(r, "", "Veil is already running."))
		return
	}
	if !s.confirmDashboardPassword(w, r) {
		return
	}
	cfg, ok, err := s.store.Configuration(r.Context(), "current")
	if err != nil || !ok {
		s.renderStatus(w, "dashboard.html", http.StatusConflict, s.dashboardData(r, "Veil is not configured.", ""))
		return
	}
	secrets := s.currentSecrets()
	err = s.supervisor.Start(r.Context(), cfg, secrets.ControlToken)
	s.actionResult(w, r, err, "veil.start")
}

func (s *Server) veilStop(w http.ResponseWriter, r *http.Request) {
	if !s.confirmDashboardPassword(w, r) {
		return
	}
	s.actionResult(w, r, s.supervisor.Stop(r.Context()), "veil.stop")
}

func (s *Server) veilRestart(w http.ResponseWriter, r *http.Request) {
	if !s.supervisor.Status().Running {
		s.render(w, "dashboard.html", s.dashboardData(r, "", "Veil is stopped. Use Start."))
		return
	}
	if !s.confirmDashboardPassword(w, r) {
		return
	}
	if wait := s.restartWait(time.Now()); wait > 0 {
		seconds := int((wait + time.Second - 1) / time.Second)
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		s.store.Audit(r.Context(), "veil.restart", "failure", time.Now())
		s.renderStatus(w, "dashboard.html", http.StatusTooManyRequests, s.dashboardData(r, "Wait a few seconds before restarting Veil again.", ""))
		return
	}
	cfg, ok, err := s.store.Configuration(r.Context(), "current")
	if err != nil || !ok {
		s.renderStatus(w, "dashboard.html", http.StatusConflict, s.dashboardData(r, "Veil is not configured.", ""))
		return
	}
	secrets := s.currentSecrets()
	err = s.supervisor.Restart(r.Context(), cfg, secrets.ControlToken)
	s.markRestart(time.Now())
	s.actionResult(w, r, err, "veil.restart")
}

func (s *Server) actionResult(w http.ResponseWriter, r *http.Request, err error, event string) {
	if err != nil {
		s.store.Audit(r.Context(), event, "failure", time.Now())
		s.renderStatus(w, "dashboard.html", statusFor(err), s.dashboardData(r, err.Error(), ""))
		return
	}
	s.store.Audit(r.Context(), event, "success", time.Now())
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) confirmDashboardPassword(w http.ResponseWriter, r *http.Request) bool {
	if err := s.freshPassword(w, r); err != nil {
		status := http.StatusInternalServerError
		message := "Password confirmation failed. Try again."
		if errors.Is(err, errPasswordConfirmation) {
			status = http.StatusUnauthorized
			message = "Owner password is incorrect."
		}
		s.renderStatus(w, "dashboard.html", status, s.dashboardData(r, message, ""))
		return false
	}
	return true
}

func (s *Server) restartWait(now time.Time) time.Duration {
	s.restartMu.Lock()
	defer s.restartMu.Unlock()
	if wait := s.restartAfter.Sub(now); wait > 0 {
		return wait
	}
	return 0
}

func (s *Server) markRestart(now time.Time) {
	s.restartMu.Lock()
	s.restartAfter = now.Add(restartCooldown)
	s.restartMu.Unlock()
}

var errPasswordConfirmation = errors.New("password confirmation failed")

func (s *Server) freshPassword(w http.ResponseWriter, r *http.Request) error {
	session := r.Context().Value(sessionKey).(requestSession)
	key := "confirm|" + session.Data.Username
	if wait := s.throttle.Wait(key, time.Now()); wait > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		return errPasswordConfirmation
	}
	if !s.store.VerifyOwner(r.Context(), session.Data.Username, r.FormValue("password")) {
		s.throttle.Failed(key, time.Now())
		return errPasswordConfirmation
	}
	s.throttle.Success(key)
	token, csrf, err := s.store.RotateSession(r.Context(), session.Token, session.Data.Username, time.Now())
	if err != nil {
		return errors.New("session rotation failed")
	}
	s.setSessionCookies(w, token, csrf)
	r.Header.Set("X-Veil-Console-CSRF", csrf)
	return nil
}

func parseSettings(r *http.Request) (config.Veil, error) {
	cfg := config.DefaultVeil()
	cfg.Protocol = r.FormValue("protocol")
	cfg.ProviderBaseURL = strings.TrimSpace(r.FormValue("provider_base_url"))
	cfg.Model = strings.TrimSpace(r.FormValue("model"))
	if value := strings.TrimSpace(r.FormValue("context_length")); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return cfg, errors.New("context length is invalid")
		}
		cfg.ContextLength = parsed
	}
	if value := strings.TrimSpace(r.FormValue("max_output_tokens")); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return cfg, errors.New("maximum output tokens is invalid")
		}
		cfg.MaxOutputTokens = parsed
	}
	if value := strings.TrimSpace(r.FormValue("model_timeout")); value != "" {
		parsed, err := time.ParseDuration(value)
		if err != nil {
			return cfg, errors.New("model timeout is invalid")
		}
		cfg.ModelTimeout = parsed
	}
	if value := strings.TrimSpace(r.FormValue("request_timeout")); value != "" {
		parsed, err := time.ParseDuration(value)
		if err != nil {
			return cfg, errors.New("request timeout is invalid")
		}
		cfg.RequestTimeout = parsed
	}
	if value := strings.TrimSpace(r.FormValue("max_body_bytes")); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return cfg, errors.New("maximum body size is invalid")
		}
		cfg.MaxBodyBytes = parsed
	}
	return cfg, cfg.Validate()
}

func (s *Server) setSessionCookies(w http.ResponseWriter, token, csrf string) {
	for _, cookie := range []*http.Cookie{
		{Name: "veil_console_session", Value: token, Path: "/", HttpOnly: true, Secure: s.startup.TrustedOrigin != "", SameSite: http.SameSiteStrictMode},
		{Name: "veil_console_csrf", Value: csrf, Path: "/", HttpOnly: true, Secure: s.startup.TrustedOrigin != "", SameSite: http.SameSiteStrictMode},
	} {
		http.SetCookie(w, cookie)
	}
}

func (s *Server) clearSessionCookies(w http.ResponseWriter) {
	for _, name := range []string{"veil_console_session", "veil_console_csrf"} {
		http.SetCookie(w, &http.Cookie{
			Name: name, Value: "", Path: "/", HttpOnly: true, Secure: s.startup.TrustedOrigin != "",
			SameSite: http.SameSiteStrictMode, MaxAge: -1,
		})
	}
}

func csrfCookie(r *http.Request) string {
	if rotated := r.Header.Get("X-Veil-Console-CSRF"); rotated != "" {
		return rotated
	}
	cookie, _ := r.Cookie("veil_console_csrf")
	if cookie == nil {
		return ""
	}
	return cookie.Value
}

func remoteIP(address string) string {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return address
	}
	return host
}

func statusFor(err error) int {
	if errors.Is(err, supervisor.ErrBusy) {
		return http.StatusConflict
	}
	return http.StatusBadRequest
}

func (s *Server) currentSecrets() state.Secrets {
	s.secretsMu.RLock()
	defer s.secretsMu.RUnlock()
	return s.secrets
}

func (s *Server) saveSecrets(secrets state.Secrets) error {
	if err := s.store.SaveSecrets(secrets); err != nil {
		return err
	}
	s.secretsMu.Lock()
	s.secrets = secrets
	s.secretsMu.Unlock()
	return nil
}

func (s *Server) render(w http.ResponseWriter, name string, data pageData) {
	s.renderStatus(w, name, http.StatusOK, data)
}

func (s *Server) renderStatus(w http.ResponseWriter, name string, status int, data pageData) {
	data.BodySizeIndex, data.BodySizeLabel = bodySizePresentation(data.Config.MaxBodyBytes)
	data.ContextIndex, data.ContextLabel = contextPresentation(data.Config.ContextLength)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := s.templates.ExecuteTemplate(w, name, data); err != nil {
		log.Printf("render template: %v", err)
	}
}

func contextPresentation(value int) (int, string) {
	presets := []int{8_192, 16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576}
	if value <= 0 {
		value = presets[3]
	}
	nearest := 0
	for index := range presets {
		if absInt(presets[index]-value) < absInt(presets[nearest]-value) {
			nearest = index
		}
	}
	if value >= 1_048_576 && value%1_048_576 == 0 {
		return nearest, fmt.Sprintf("%dM tokens", value/1_048_576)
	}
	if value%1024 == 0 {
		return nearest, fmt.Sprintf("%dK tokens", value/1024)
	}
	return nearest, fmt.Sprintf("%d tokens", value)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, "ok\n")
}

func (s *Server) style(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/style.css")
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(payload)
}

func (s *Server) accessStyle(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/access.css")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(payload)
}

func (s *Server) settingsStyle(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/settings.css")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(payload)
}

func (s *Server) script(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/console.js")
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(payload)
}

func (s *Server) logo(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/umbratic-icon.png")
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(payload)
}

func (s *Server) favicon(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/favicon.ico")
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/x-icon")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(payload)
}

func bodySizePresentation(value int64) (int, string) {
	const mebibyte = int64(1 << 20)
	presets := []int64{16 * mebibyte, 32 * mebibyte, 64 * mebibyte, 128 * mebibyte, 256 * mebibyte}
	if value <= 0 {
		value = presets[2]
	}
	nearest := 0
	for index := range presets {
		if abs64(presets[index]-value) < abs64(presets[nearest]-value) {
			nearest = index
		}
	}
	if value%mebibyte == 0 {
		return nearest, fmt.Sprintf("%d MiB", value/mebibyte)
	}
	return nearest, fmt.Sprintf("%d bytes", value)
}

func abs64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

type attempt struct {
	failures int
	next     time.Time
}

type loginThrottle struct {
	mu       sync.Mutex
	attempts map[string]attempt
}

func newLoginThrottle() *loginThrottle { return &loginThrottle{attempts: map[string]attempt{}} }

func (t *loginThrottle) Wait(key string, now time.Time) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	if wait := t.attempts[key].next.Sub(now); wait > 0 {
		return wait
	}
	return 0
}

func (t *loginThrottle) Failed(key string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	value := t.attempts[key]
	value.failures++
	delay := 2 * time.Second
	value.next = now.Add(delay)
	t.attempts[key] = value
	if len(t.attempts) > 2048 {
		for candidate, record := range t.attempts {
			if !record.next.After(now) {
				delete(t.attempts, candidate)
			}
			if len(t.attempts) <= 1024 {
				break
			}
		}
	}
}

func retryAfterSeconds(wait time.Duration) int {
	return max(1, int((wait+time.Second-1)/time.Second))
}

func (t *loginThrottle) Success(key string) {
	t.mu.Lock()
	delete(t.attempts, key)
	t.mu.Unlock()
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.supervisor.Stop(ctx)
}

func (s *Server) StartLastKnownGood(ctx context.Context) {
	cfg, ok, err := s.store.Configuration(ctx, "current")
	if err != nil || !ok {
		return
	}
	secrets := s.currentSecrets()
	if err := s.supervisor.Start(ctx, cfg, secrets.ControlToken); err != nil {
		log.Printf("Veil did not start from the last known-good configuration")
	}
}

func (s *Server) Address() string {
	return net.JoinHostPort(s.startup.Listen, strconv.Itoa(s.startup.Port))
}

func (s *Server) String() string { return fmt.Sprintf("Veil Console on %s", s.Address()) }
