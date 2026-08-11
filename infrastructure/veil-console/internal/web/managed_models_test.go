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
		"csrf":                   {csrf},
		"password":               {ownerPassword},
		"id":                     {"qwen3-32b"},
		"display_name":           {"Qwen 32B"},
		"model_path":             {"Qwen/Qwen3-32B"},
		"port":                   {"8001"},
		"max_model_len":          {"32768"},
		"gpu_memory_utilization": {"0.45"},
		"kv_cache_dtype":         {"fp8"},
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

// refreshedSession follows the session rotation that every owner-password
// confirmation performs, so a test can make more than one write.
func refreshedSession(response *httptest.ResponseRecorder, cookies []*http.Cookie, csrf string) ([]*http.Cookie, string) {
	next := response.Result().Cookies()
	if len(next) == 0 {
		return cookies, csrf
	}
	for _, cookie := range next {
		if strings.Contains(cookie.Name, "csrf") {
			csrf = cookie.Value
		}
	}
	return next, csrf
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

func TestModelWritesRequireCSRF(t *testing.T) {
	_, handler, cookies, _, closeServer := signedInConsole(t)
	defer closeServer()
	// A session cookie with no CSRF token must not create anything.
	response := authorizedPost(t, handler, cookies, "/models/create", modelFormValues("", map[string]string{"csrf": ""}))
	if response.Code != http.StatusForbidden {
		t.Fatalf("a missing CSRF token was accepted: %d", response.Code)
	}
}

func TestModelWritesRequireTheOwnerPassword(t *testing.T) {
	server, handler, cookies, csrf, closeServer := signedInConsole(t)
	defer closeServer()
	response := authorizedPost(t, handler, cookies, "/models/create",
		modelFormValues(csrf, map[string]string{"password": "wrong password"}))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("a wrong owner password was accepted: %d", response.Code)
	}
	if models, _ := server.store.ManagedModels(t.Context()); len(models) != 0 {
		t.Fatalf("nothing must be registered: %#v", models)
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
	if models[0].KVCacheDType != config.KVCacheFP8 {
		t.Fatalf("fp8 is the default 8-bit KV cache: %#v", models[0])
	}
	if models[0].Reasoning {
		t.Fatal("an unchecked reasoning box must not declare reasoning")
	}
	// The registry reached the supervisor, so the next Veil start carries it.
	if !strings.Contains(server.supervisor.PendingModelsEnvironment(), `"qwen3-32b"`) {
		t.Fatalf("the registry must be handed to Veil: %q", server.supervisor.PendingModelsEnvironment())
	}

	cookies, csrf = refreshedSession(create, cookies, csrf)
	update := authorizedPost(t, handler, cookies, "/models/qwen3-32b/update",
		modelFormValues(csrf, map[string]string{"display_name": "Qwen 32B long", "max_model_len": "98304", "reasoning": "on"}))
	if update.Code != http.StatusSeeOther {
		body, _ := io.ReadAll(update.Result().Body)
		t.Fatalf("update failed: %d %s", update.Code, body)
	}
	stored, _, _ := server.store.ManagedModel(t.Context(), "qwen3-32b")
	if stored.DisplayName != "Qwen 32B long" || stored.MaxModelLen != 98304 || !stored.Reasoning {
		t.Fatalf("the update must persist: %#v", stored)
	}

	cookies, csrf = refreshedSession(update, cookies, csrf)
	remove := authorizedPost(t, handler, cookies, "/models/qwen3-32b/delete", url.Values{
		"csrf": {csrf}, "password": {ownerPassword},
	})
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

func TestModelFormRefusesInvalidValuesWithoutStoringThem(t *testing.T) {
	server, handler, cookies, csrf, closeServer := signedInConsole(t)
	defer closeServer()

	for name, overrides := range map[string]map[string]string{
		"served id that is a flag":  {"id": "--trust-remote-code"},
		"model path that is a flag": {"model_path": "--trust-remote-code"},
		"privileged port":           {"port": "80"},
		"port that is not a number": {"port": "eighty"},
		"unknown kv dtype":          {"kv_cache_dtype": "q8"},
		"gpu fraction above one":    {"gpu_memory_utilization": "1.4"},
		"the console port":          {"port": "8177"},
		"the veil port":             {"port": "8080"},
	} {
		t.Run(name, func(t *testing.T) {
			response := authorizedPost(t, handler, cookies, "/models/create", modelFormValues(csrf, overrides))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d", response.Code)
			}
			if models, _ := server.store.ManagedModels(t.Context()); len(models) != 0 {
				t.Fatalf("a refused form must store nothing: %#v", models)
			}
			cookies, csrf = refreshedSession(response, cookies, csrf)
		})
	}
}

func TestModelsPageRendersTheFleetAndItsState(t *testing.T) {
	_, handler, cookies, csrf, closeServer := signedInConsole(t)
	defer closeServer()
	create := authorizedPost(t, handler, cookies, "/models/create", modelFormValues(csrf, nil))
	if create.Code != http.StatusSeeOther {
		t.Fatalf("create failed: %d", create.Code)
	}
	cookies, _ = refreshedSession(create, cookies, csrf)

	page := authorizedGet(t, handler, cookies, "/models")
	if page.Code != http.StatusOK {
		t.Fatalf("the models page failed: %d", page.Code)
	}
	body := page.Body.String()
	for _, expected := range []string{
		"Qwen 32B", "qwen3-32b", "port 8001", "max len 32k", "GPU 0.45", "KV fp8",
		// Registered but never started, and the page says so rather than
		// leaving the row ambiguous.
		"model-dot model-dot-stopped",
		// Console has no vLLM binary in tests, and the page explains it.
		"--vllm-binary",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("the models page must show %q", expected)
		}
	}
	// Veil is not running here, so there is nothing for a registry change to be
	// pending against and the notice would be noise.
	if strings.Contains(body, "Restart Veil to apply model list changes") {
		t.Fatal("the apply notice must not appear while Veil is stopped")
	}
}
