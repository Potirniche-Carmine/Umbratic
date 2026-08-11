package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"umbratic-veil-console/internal/config"
)

const ownerPassword = "a long owner password"

const testCommand = "serve Qwen/Qwen3-32B --host 127.0.0.1 --port 8001 --served-model-name qwen3-32b --max-model-len 32768 --gpu-memory-utilization 0.45 --kv-cache-dtype fp8"

// signedInConsole returns a handler with an owner account and the session
// cookies to use it, which is the precondition for every route below.
func signedInConsole(t *testing.T) (*Server, http.Handler, []*http.Cookie, string, func()) {
	t.Helper()
	server, closeServer := testServer(t)
	handler := server.Handler()
	setupCode, err := server.store.NewSetup(t.Context(), time.Now())
	if err != nil {
		closeServer()
		t.Fatal(err)
	}
	getSetup := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/setup", nil)
	getSetup.Host = "127.0.0.1:8177"
	setupResponse := httptest.NewRecorder()
	handler.ServeHTTP(setupResponse, getSetup)
	publicCookie := setupResponse.Result().Cookies()[0]
	csrf := publicCookie.Value

	setupForm := url.Values{"csrf": {csrf}, "setup_code": {setupCode}, "username": {"owner"}, "password": {ownerPassword}}
	submit := httptest.NewRecorder()
	handler.ServeHTTP(submit, formRequest(http.MethodPost, "/setup", setupForm, publicCookie))
	if submit.Code != http.StatusSeeOther {
		closeServer()
		t.Fatalf("setup failed: %d %s", submit.Code, submit.Body.String())
	}
	loginForm := url.Values{"csrf": {csrf}, "username": {"owner"}, "password": {ownerPassword}}
	login := httptest.NewRecorder()
	handler.ServeHTTP(login, formRequest(http.MethodPost, "/login", loginForm, publicCookie))
	if login.Code != http.StatusSeeOther {
		closeServer()
		t.Fatalf("login failed: %d %s", login.Code, login.Body.String())
	}
	cookies := login.Result().Cookies()
	sessionCSRF := csrf
	for _, cookie := range cookies {
		if strings.Contains(cookie.Name, "csrf") {
			sessionCSRF = cookie.Value
		}
	}
	return server, handler, cookies, sessionCSRF, closeServer
}

func authorizedGet(t *testing.T, handler http.Handler, cookies []*http.Cookie, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177"+path, nil)
	request.Host = "127.0.0.1:8177"
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func authorizedPost(t *testing.T, handler http.Handler, cookies []*http.Cookie, path string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8177"+path, strings.NewReader(form.Encode()))
	request.Host = "127.0.0.1:8177"
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "http://127.0.0.1:8177")
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func modelFormValues(csrf string, overrides map[string]string) url.Values {
	form := url.Values{
		"csrf":         {csrf},
		"id":           {"qwen3-32b"},
		"display_name": {"Qwen 32B"},
		"command":      {testCommand},
	}
	for key, value := range overrides {
		if value == "" {
			form.Del(key)
			continue
		}
		form.Set(key, value)
	}
	return form
}

func TestModelsPageRequiresASession(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8177/models", nil)
	request.Host = "127.0.0.1:8177"
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusSeeOther && response.Code != http.StatusFound {
		t.Fatalf("an unauthenticated request must be sent to login, got %d", response.Code)
	}
}

// The owner password is no longer asked for on this page — a locked, local
// deployment does not re-authenticate every click — but the session and the
// CSRF token are still the gate on every write.
func TestModelWritesRequireCSRF(t *testing.T) {
	_, handler, cookies, _, closeServer := signedInConsole(t)
	defer closeServer()
	response := authorizedPost(t, handler, cookies, "/models/create", modelFormValues("", map[string]string{"csrf": ""}))
	if response.Code != http.StatusForbidden {
		t.Fatalf("a missing CSRF token was accepted: %d", response.Code)
	}
}

func TestModelLifecycleThroughTheWeb(t *testing.T) {
	server, handler, cookies, csrf, closeServer := signedInConsole(t)
	defer closeServer()

	create := authorizedPost(t, handler, cookies, "/models/create", modelFormValues(csrf, nil))
	if create.Code != http.StatusSeeOther {
		body, _ := io.ReadAll(create.Result().Body)
		t.Fatalf("create failed: %d %s", create.Code, body)
	}
	models, err := server.store.ManagedModels(t.Context())
	if err != nil || len(models) != 1 {
		t.Fatalf("the model must be registered: %#v %v", models, err)
	}
	// Saving lays the arguments out one per line, so a pasted one-liner comes
	// back readable.
	wantPrefix := strings.Join([]string{"serve Qwen/Qwen3-32B", "--host 127.0.0.1", "--port 8001", ""}, "\n")
	if !strings.HasPrefix(models[0].Command, wantPrefix) {
		t.Fatalf("the command must be stored one flag per line: %q", models[0].Command)
	}
	if models[0].Port() != 8001 {
		t.Fatalf("the port must be read out of the command: %d", models[0].Port())
	}

	if !strings.Contains(server.supervisor.PendingModelsEnvironment(), `"qwen3-32b"`) {
		t.Fatalf("the registry must be handed to Veil: %q", server.supervisor.PendingModelsEnvironment())
	}

	// Editing the command is the point of the card: it is saved as typed.
	edited := strings.Replace(models[0].Command, "--max-model-len 32768", "--max-model-len 98304", 1)
	update := authorizedPost(t, handler, cookies, "/models/qwen3-32b/update", url.Values{
		"csrf": {csrf}, "display_name": {"Qwen 32B long"}, "command": {edited},
	})
	if update.Code != http.StatusSeeOther {
		body, _ := io.ReadAll(update.Result().Body)
		t.Fatalf("update failed: %d %s", update.Code, body)
	}
	stored, _, _ := server.store.ManagedModel(t.Context(), "qwen3-32b")
	if stored.DisplayName != "Qwen 32B long" || stored.Command != edited {
		t.Fatalf("the update must persist: %#v", stored)
	}
	// The window Veil publishes follows the command it was read from.
	if !strings.Contains(server.supervisor.PendingModelsEnvironment(), `"context_length":98304`) {
		t.Fatalf("the published window must follow the command: %q", server.supervisor.PendingModelsEnvironment())
	}

	remove := authorizedPost(t, handler, cookies, "/models/qwen3-32b/delete", url.Values{"csrf": {csrf}})
	if remove.Code != http.StatusSeeOther {
		body, _ := io.ReadAll(remove.Result().Body)
		t.Fatalf("delete failed: %d %s", remove.Code, body)
	}
	if models, _ := server.store.ManagedModels(t.Context()); len(models) != 0 {
		t.Fatalf("the model must be gone: %#v", models)
	}
	if server.supervisor.PendingModelsEnvironment() != "" {
		t.Fatalf("an empty registry means no VEIL_MODELS: %q", server.supervisor.PendingModelsEnvironment())
	}
}

// The command reaches the database only if it would also reach argv. Every one
// of these is refused at the form, so a row that cannot start cannot be stored.
func TestModelFormRefusesCommandsThatCannotRun(t *testing.T) {
	server, handler, cookies, csrf, closeServer := signedInConsole(t)
	defer closeServer()

	for name, command := range map[string]string{
		"command chaining":  testCommand + " ; rm -rf /",
		"piping to a shell": testCommand + " | sh",
		"substitution":      testCommand + " --seed $(id -u)",
		"redirection":       testCommand + " > /etc/passwd",
		"missing port":      "serve Qwen/Qwen3-32B --served-model-name qwen3-32b",
		"missing served id": "serve Qwen/Qwen3-32B --port 8001",
		"renamed served id": "serve Qwen/Qwen3-32B --port 8001 --served-model-name other",
		"privileged port":   "serve Qwen/Qwen3-32B --port 80 --served-model-name qwen3-32b",
		"the console port":  "serve Qwen/Qwen3-32B --port 8177 --served-model-name qwen3-32b",
		"the veil port":     "serve Qwen/Qwen3-32B --port 8080 --served-model-name qwen3-32b",
		"flag as model":     "serve --trust-remote-code --port 8001 --served-model-name qwen3-32b",
	} {
		t.Run(name, func(t *testing.T) {
			response := authorizedPost(t, handler, cookies, "/models/create",
				modelFormValues(csrf, map[string]string{"command": command}))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d", response.Code)
			}
			if models, _ := server.store.ManagedModels(t.Context()); len(models) != 0 {
				t.Fatalf("a refused command must store nothing: %#v", models)
			}
		})
	}
}

func TestModelsPageRendersTheCommandAndItsState(t *testing.T) {
	_, handler, cookies, csrf, closeServer := signedInConsole(t)
	defer closeServer()
	create := authorizedPost(t, handler, cookies, "/models/create", modelFormValues(csrf, nil))
	if create.Code != http.StatusSeeOther {
		t.Fatalf("create failed: %d", create.Code)
	}

	page := authorizedGet(t, handler, cookies, "/models")
	if page.Code != http.StatusOK {
		t.Fatalf("the models page failed: %d", page.Code)
	}
	body := page.Body.String()
	for _, expected := range []string{
		"Qwen 32B", "qwen3-32b",
		// The command is editable on the card, shown exactly as stored.
		"--kv-cache-dtype fp8",
		`name="command"`,
		// Registered but never started, capitalized.
		"model-dot model-dot-stopped", ">Stopped<",
		// Console has no vLLM binary in tests, and the page explains it.
		"--vllm-binary",
		// The reserved notice line is present even with nothing to say.
		"model-notice is-empty",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("the models page must show %q", expected)
		}
	}
	// The counts line moved to the dashboard; the cards say what they are doing.
	if strings.Contains(body, "registered</span>") {
		t.Fatal("the Models header must not repeat the dashboard's counts")
	}
	// No owner password anywhere on this page.
	if strings.Contains(body, `type="password"`) {
		t.Fatal("the Models page must not ask for the owner password")
	}
	// Thinking is a chat-template default whose kwarg is named differently per
	// model family, so the card offers no control that would have to guess it.
	if strings.Contains(body, `name="thinking"`) || strings.Contains(body, "Emits thinking") {
		t.Fatal("thinking belongs in the command, not in a control that guesses the kwarg name")
	}
}

// A saved command only takes effect on restart, and the card has to say so
// rather than letting an administrator believe an edit is live.
func TestASavedCommandThatIsNotRunningYetIsCalledOut(t *testing.T) {
	model := managedTestModel()
	if got := modelNotice(model, false, false); got != "" {
		t.Fatalf("a stopped, saved model has nothing to report: %q", got)
	}
	if got := modelNotice(model, true, false); got != "" {
		t.Fatalf("a model running its saved command has nothing to report: %q", got)
	}
	if got := modelNotice(model, true, true); got != "Saved. Restart to run this command." {
		t.Fatalf("a stale command must be called out: %q", got)
	}
	broken := model
	broken.Command = "serve Qwen/Qwen3-32B --served-model-name qwen3-32b"
	if got := modelNotice(broken, false, false); !strings.Contains(got, "will not start") {
		t.Fatalf("a command that cannot start must say so: %q", got)
	}
}

func managedTestModel() config.ManagedModel {
	return config.ManagedModel{ID: "qwen3-32b", DisplayName: "Qwen 32B", Command: testCommand}
}
