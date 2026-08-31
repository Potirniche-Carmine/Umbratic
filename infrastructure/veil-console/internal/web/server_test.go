package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/rag"
	"umbratic-veil-console/internal/state"
	"umbratic-veil-console/internal/supervisor"
)

func testServer(t *testing.T) (*Server, func()) {
	return testServerWithTrustedOrigin(t, "")
}

func testServerWithTrustedOrigin(t *testing.T, trustedOrigin string) (*Server, func()) {
	t.Helper()
	dir := tempStateDir(t)
	binary := filepath.Join(dir, "veil")
	if err := os.WriteFile(binary, []byte("fake"), 0o700); err != nil {
		t.Fatal(err)
	}
	startup := config.Startup{
		Listen: "127.0.0.1", Port: 8177, StateDir: filepath.Join(dir, "state"),
		VeilBinary: binary, VeilAddress: "127.0.0.1:8080", TrustedOrigin: trustedOrigin,
	}
	if err := config.ValidateStartup(&startup); err != nil {
		t.Fatal(err)
	}
	store, err := state.Open(startup.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	secrets, err := store.LoadOrCreateSecrets()
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	corpus, err := rag.NewCorpus(store, filepath.Join(startup.StateDir, "documents"), "", config.DefaultRAG(), "")
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	server, err := New(startup, store, secrets, supervisor.New(binary, startup.VeilAddress), corpus)
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	return server, func() { _ = store.Close() }
}

func TestHTTPSOriginUsesStandardProtectionAndSecureCookies(t *testing.T) {
	server, closeServer := testServerWithTrustedOrigin(t, "https://console.example.com")
	defer closeServer()

	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8177/setup", nil)
	request.Header.Set("Origin", "https://console.example.com")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	if err := server.crossOrigin.Check(request); err != nil {
		t.Fatalf("trusted HTTPS origin was rejected: %v", err)
	}

	response := httptest.NewRecorder()
	server.setSessionCookies(response, "session", "csrf")
	for _, cookie := range response.Result().Cookies() {
		if !cookie.Secure {
			t.Errorf("HTTPS cookie is not Secure: %s", cookie.Name)
		}
		if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
			t.Errorf("session cookie attributes are unsafe: %s", cookie.Name)
		}
		if cookie.MaxAge != 0 || !cookie.Expires.IsZero() {
			t.Errorf("session cookie is persistent: %s", cookie.Name)
		}
	}
}

func TestSecurityHeadersAndHostValidation(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/healthz", nil)
	req.Host = "127.0.0.1:8177"
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Security-Policy") == "" || recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing security response: %d %#v", recorder.Code, recorder.Header())
	}
	req = httptest.NewRequest(http.MethodGet, "http://attacker.test/healthz", nil)
	req.Host = "attacker.test"
	recorder = httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unsafe Host was accepted: %d", recorder.Code)
	}

	logoRequest := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/assets/umbratic-icon.png", nil)
	logoRequest.Host = "127.0.0.1:8177"
	logoResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(logoResponse, logoRequest)
	if logoResponse.Code != http.StatusOK || logoResponse.Header().Get("Content-Type") != "image/png" || logoResponse.Body.Len() == 0 {
		t.Fatalf("brand asset was not served: %d %#v", logoResponse.Code, logoResponse.Header())
	}

	faviconRequest := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/favicon.ico", nil)
	faviconRequest.Host = "127.0.0.1:8177"
	faviconResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(faviconResponse, faviconRequest)
	if faviconResponse.Code != http.StatusOK || faviconResponse.Header().Get("Content-Type") != "image/x-icon" || faviconResponse.Body.Len() == 0 {
		t.Fatalf("favicon was not served: %d %#v", faviconResponse.Code, faviconResponse.Header())
	}
}

func TestSetupRejectsMissingCSRF(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8177/setup", strings.NewReader("username=owner"))
	req.Host = "127.0.0.1:8177"
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "http://127.0.0.1:8177")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF was accepted: %d", recorder.Code)
	}
}

func TestFormOriginAcceptsOnlyConsoleLoopbackOrigins(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	for _, origin := range []string{
		"http://127.0.0.1:8177",
		"http://localhost:8177",
		"http://[::1]:8177",
	} {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8177/setup", nil)
		request.Header.Set("Origin", origin)
		request.Header.Set("Sec-Fetch-Site", "cross-site")
		if err := server.crossOrigin.Check(request); err != nil {
			t.Errorf("valid loopback origin was rejected: %s: %v", origin, err)
		}
	}
	for _, origin := range []string{
		"https://127.0.0.1:8177",
		"http://127.0.0.1:8080",
		"http://attacker.test:8177",
	} {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8177/setup", nil)
		request.Header.Set("Origin", origin)
		request.Header.Set("Sec-Fetch-Site", "cross-site")
		if err := server.crossOrigin.Check(request); err == nil {
			t.Errorf("untrusted origin was accepted: %s", origin)
		}
	}
}

func TestSetupLoginAndAuthenticatedPage(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	setupCode, err := server.store.NewSetup(t.Context(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()
	getSetup := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/setup", nil)
	getSetup.Host = "127.0.0.1:8177"
	setupResponse := httptest.NewRecorder()
	handler.ServeHTTP(setupResponse, getSetup)
	publicCookie := setupResponse.Result().Cookies()[0]
	csrf := publicCookie.Value

	setupForm := url.Values{"csrf": {csrf}, "setup_code": {setupCode}, "username": {"owner"}, "password": {"a long owner password"}}
	postSetup := formRequest(http.MethodPost, "/setup", setupForm, publicCookie)
	setupSubmitResponse := httptest.NewRecorder()
	handler.ServeHTTP(setupSubmitResponse, postSetup)
	if setupSubmitResponse.Code != http.StatusSeeOther {
		t.Fatalf("setup failed: %d %s", setupSubmitResponse.Code, setupSubmitResponse.Body.String())
	}

	loginForm := url.Values{"csrf": {csrf}, "username": {"owner"}, "password": {"a long owner password"}}
	postLogin := formRequest(http.MethodPost, "/login", loginForm, publicCookie)
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, postLogin)
	if loginResponse.Code != http.StatusSeeOther {
		t.Fatalf("login failed: %d %s", loginResponse.Code, loginResponse.Body.String())
	}
	cookies := loginResponse.Result().Cookies()
	getDashboard := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/", nil)
	getDashboard.Host = "127.0.0.1:8177"
	for _, cookie := range cookies {
		getDashboard.AddCookie(cookie)
	}
	dashboardResponse := httptest.NewRecorder()
	handler.ServeHTTP(dashboardResponse, getDashboard)
	if dashboardResponse.Code != http.StatusOK {
		body, _ := io.ReadAll(dashboardResponse.Result().Body)
		t.Fatalf("authenticated page failed: %d %s", dashboardResponse.Code, body)
	}
	secrets := server.currentSecrets()
	if strings.Contains(dashboardResponse.Body.String(), secrets.VeilToken) || strings.Contains(dashboardResponse.Body.String(), secrets.CSRFKey) {
		t.Fatal("authenticated page leaked a secret")
	}

	unknownRequest := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/not-a-page", nil)
	unknownRequest.Host = "127.0.0.1:8177"
	for _, cookie := range cookies {
		unknownRequest.AddCookie(cookie)
	}
	unknownResponse := httptest.NewRecorder()
	handler.ServeHTTP(unknownResponse, unknownRequest)
	if unknownResponse.Code != http.StatusSeeOther || unknownResponse.Header().Get("Location") != "/" {
		t.Fatalf("unknown page did not redirect home: %d %q", unknownResponse.Code, unknownResponse.Header().Get("Location"))
	}

	touchRequest := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/session/touch", nil)
	touchRequest.Host = "127.0.0.1:8177"
	for _, cookie := range cookies {
		touchRequest.AddCookie(cookie)
	}
	touchResponse := httptest.NewRecorder()
	handler.ServeHTTP(touchResponse, touchRequest)
	if touchResponse.Code != http.StatusNoContent {
		t.Fatalf("session heartbeat failed: %d", touchResponse.Code)
	}

	var sessionCSRF string
	for _, cookie := range cookies {
		if cookie.Name == "veil_console_csrf" {
			sessionCSRF = cookie.Value
		}
	}
	settingsForm := url.Values{
		"csrf":                             {sessionCSRF},
		"provider_base_url":                {"http://127.0.0.1:8000/v1"},
		"model":                            {"local-model"},
		"context_length":                   {"65536"},
		"max_output_tokens":                {"8192"},
		"temperature":                      {"0.2"},
		"top_p":                            {"0.95"},
		"reasoning_effort":                 {"none"},
		"parallel_tool_calls":              {"true"},
		"max_concurrent_requests":          {"32"},
		"max_concurrent_requests_per_user": {"4"},
		"queue_timeout":                    {"30s"},
		"model_timeout":                    {"1m"},
		"request_timeout":                  {"1m15s"},
		"max_body_bytes":                   {"67108864"},
		"password":                         {"wrong password"},
	}
	for _, path := range []string{"/settings/test", "/settings/apply"} {
		settingsRequest := formRequest(http.MethodPost, path, settingsForm, cookies...)
		settingsResponse := httptest.NewRecorder()
		handler.ServeHTTP(settingsResponse, settingsRequest)
		if settingsResponse.Code != http.StatusUnauthorized {
			t.Fatalf("%s wrong confirmation password returned %d", path, settingsResponse.Code)
		}
		if body := settingsResponse.Body.String(); !strings.Contains(body, "Owner password is incorrect.") || !strings.Contains(body, "<h1>Settings</h1>") {
			t.Fatalf("%s password error did not render in the app: %s", path, body)
		} else if strings.Contains(body, "wrong password") {
			t.Fatalf("%s echoed the submitted password", path)
		}
	}

	startForm := url.Values{"csrf": {sessionCSRF}, "password": {"wrong password"}}
	startRequest := formRequest(http.MethodPost, "/veil/start", startForm, cookies...)
	startResponse := httptest.NewRecorder()
	handler.ServeHTTP(startResponse, startRequest)
	if startResponse.Code != http.StatusUnauthorized {
		t.Fatalf("start accepted a wrong owner password: %d", startResponse.Code)
	}
	if body := startResponse.Body.String(); !strings.Contains(body, "Owner password is incorrect.") || !strings.Contains(body, "<h1>Veil</h1>") {
		t.Fatalf("start password error did not render in the app: %s", body)
	}
}

func TestWrongLoginUsesFloatingErrorAndRequiresRetryDelay(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()

	emptyPage := httptest.NewRecorder()
	server.render(emptyPage, "login.html", pageData{Title: "Sign in", CSRF: "csrf"})
	if body := emptyPage.Body.String(); !strings.Contains(body, `class="error auth-error is-empty"`) ||
		!strings.Contains(body, `data-retry-after="0"`) ||
		!strings.Contains(body, `/assets/style.css?v=9`) ||
		!strings.Contains(body, `/assets/console.js?v=9`) {
		t.Fatalf("login page did not render the hidden error and current assets: %s", body)
	}

	csrfResponse := httptest.NewRecorder()
	csrfRequest := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/login", nil)
	csrf := server.publicCSRF(csrfResponse, csrfRequest)
	form := url.Values{"csrf": {csrf}, "username": {"owner"}, "password": {"wrong password"}}
	request := formRequest(http.MethodPost, "/login", form, csrfResponse.Result().Cookies()...)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || response.Header().Get("Retry-After") != "2" {
		t.Fatalf("wrong login returned %d with retry %q", response.Code, response.Header().Get("Retry-After"))
	}
	if body := response.Body.String(); !strings.Contains(body, `class="error auth-error"`) ||
		strings.Contains(body, `auth-error is-empty`) || !strings.Contains(body, `data-retry-after="2"`) {
		t.Fatalf("wrong login did not render a stable retry state: %s", body)
	}
}

func TestLoginRetryDelayStaysAtTwoSeconds(t *testing.T) {
	throttle := newLoginThrottle()
	now := time.Now()
	throttle.Failed("owner", now)
	if wait := throttle.Wait("owner", now); wait != 2*time.Second {
		t.Fatalf("first retry delay was %s", wait)
	}
	throttle.Failed("owner", now.Add(3*time.Second))
	if wait := throttle.Wait("owner", now.Add(3*time.Second)); wait != 2*time.Second {
		t.Fatalf("repeated retry delay was %s", wait)
	}
}

func TestDashboardHidesStartWhenVeilIsRunning(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	response := httptest.NewRecorder()
	server.render(response, "dashboard.html", pageData{
		Title: "Veil Console", CSRF: "test", Configured: true, Running: true, Healthy: true, Status: "Running",
		VeilURL: "http://127.0.0.1:8080",
	})
	body := response.Body.String()
	if strings.Contains(body, `action="/veil/start"`) {
		t.Fatal("dashboard showed Start while Veil was running")
	}
	if !strings.Contains(body, `action="/veil/restart"`) {
		t.Fatal("dashboard did not show Restart while Veil was running")
	}
	if !strings.Contains(body, `name="password"`) {
		t.Fatal("Restart did not require the owner password")
	}
	if !strings.Contains(body, "Connect at") || !strings.Contains(body, "http://127.0.0.1:8080") {
		t.Fatal("dashboard did not show the Veil connection address")
	}

	response = httptest.NewRecorder()
	server.render(response, "dashboard.html", pageData{
		Title: "Veil Console", CSRF: "test", Configured: true, Running: false, Status: "Stopped",
	})
	body = response.Body.String()
	if strings.Contains(body, `action="/veil/restart"`) {
		t.Fatal("dashboard showed Restart while Veil was stopped")
	}
	if !strings.Contains(body, `action="/veil/start"`) || !strings.Contains(body, `name="password"`) {
		t.Fatal("stopped dashboard did not show password-protected Start")
	}
}

func TestRestartCooldown(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	now := time.Unix(1000, 0)
	server.markRestart(now)
	if wait := server.restartWait(now); wait != restartCooldown {
		t.Fatalf("restart cooldown = %v", wait)
	}
	if wait := server.restartWait(now.Add(restartCooldown)); wait != 0 {
		t.Fatalf("restart cooldown did not expire: %v", wait)
	}
}

// Context is a per-model label now, not a slider index. What matters is that
// what the Settings page prints for the default model reads as tokens.
func TestContextLabelReadsAsTokens(t *testing.T) {
	for value, want := range map[int]string{
		65_536:    "64K",
		262_144:   "256K",
		1_048_576: "1M",
	} {
		if got := config.ContextLabel(value); got != want {
			t.Errorf("context %d presented as %q, want %q", value, got, want)
		}
	}
}

func formRequest(method, path string, values url.Values, cookies ...*http.Cookie) *http.Request {
	request := httptest.NewRequest(method, "http://127.0.0.1:8177"+path, strings.NewReader(values.Encode()))
	request.Host = "127.0.0.1:8177"
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "http://127.0.0.1:8177")
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	return request
}

// tempStateDir resolves symlinks in the test directory because the state store
// rejects paths that contain one, and macOS puts temporary files under /var.
func tempStateDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// Every stylesheet and script a template links has to actually be served. The
// pages used to name their assets in one place and route them in another, and
// controls.css shipped linked-but-unrouted: the console rendered with half its
// styling and nothing errored.
func TestEveryLinkedAssetIsServed(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	handler := server.Handler()

	linked := map[string]bool{}
	pattern := regexp.MustCompile(`(?:href|src)="(/assets/[A-Za-z0-9._-]+)`)
	entries, err := content.ReadDir("templates")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		body, err := content.ReadFile("templates/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range pattern.FindAllStringSubmatch(string(body), -1) {
			linked[match[1]] = true
		}
	}
	if len(linked) == 0 {
		t.Fatal("no assets were found in the templates")
	}
	for path := range linked {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Host = "127.0.0.1:8177"
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s is linked by a template but answers %d", path, response.Code)
		}
	}
}

// The asset handler serves a directory, so it has to refuse everything that is
// not one of its own files.
func TestAssetHandlerRefusesTraversalAndUnknownTypes(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	handler := server.Handler()
	for _, path := range []string{
		"/assets/../server.go",
		"/assets/console.db",
		"/assets/.hidden",
		"/assets/nothing.css",
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Host = "127.0.0.1:8177"
		handler.ServeHTTP(response, request)
		if response.Code == http.StatusOK {
			t.Fatalf("%s must not be served", path)
		}
	}
}
