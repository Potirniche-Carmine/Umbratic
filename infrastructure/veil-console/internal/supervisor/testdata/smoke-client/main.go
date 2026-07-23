package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	consoleURL = "http://127.0.0.1:8177"
	username   = "smoke-owner"
	password   = "Veil Console test password 2026"
)

var csrfPattern = regexp.MustCompile(`name="csrf" value="([^"]+)"`)
var tokenPattern = regexp.MustCompile(`<pre[^>]*>([^<]+)</pre>`)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--verify-persist" {
		verifyPersistence()
		return
	}
	if len(os.Args) != 3 {
		fatalf("usage: smoke-client <setup-code> <state-dir> | --verify-persist")
	}
	client := newClient()
	setupPage := get(client, "/setup", http.StatusOK)
	publicCSRF := extract(csrfPattern, setupPage, "setup CSRF")
	post(client, "/setup", url.Values{
		"csrf": {publicCSRF}, "setup_code": {os.Args[1]}, "username": {username}, "password": {password},
	}, http.StatusSeeOther)
	post(client, "/login", url.Values{
		"csrf": {publicCSRF}, "username": {username}, "password": {password},
	}, http.StatusSeeOther)

	csrf := sessionCSRF(client)
	post(client, "/veil/restart", url.Values{}, http.StatusForbidden)
	settings := settingsValues(csrf, "http://127.0.0.1:18000")
	post(client, "/settings/test", settings, http.StatusOK)
	settings.Set("password", password)
	applyPage := post(client, "/settings/apply", settings, http.StatusOK)
	veilToken := extract(tokenPattern, applyPage, "one-time Veil token")
	waitForHealth(veilToken)

	csrf = sessionCSRF(client)
	post(client, "/veil/restart", url.Values{"csrf": {csrf}}, http.StatusSeeOther)
	waitForHealth(veilToken)

	csrf = sessionCSRF(client)
	invalid := settingsValues(csrf, "http://127.0.0.1:19999")
	invalid.Set("password", password)
	post(client, "/settings/apply", invalid, http.StatusBadRequest)
	waitForHealth(veilToken)

	dashboard := get(client, "/", http.StatusOK)
	if strings.Contains(dashboard, veilToken) {
		fatalf("dashboard leaked a secret")
	}
	database, err := os.ReadFile(os.Args[2] + "/console.db")
	if err != nil {
		fatalf("read Console database: %v", err)
	}
	if bytes.Contains(database, []byte(veilToken)) {
		fatalf("Console database leaked a secret")
	}

	throttled := newClient()
	loginPage := get(throttled, "/login", http.StatusOK)
	loginCSRF := extract(csrfPattern, loginPage, "login CSRF")
	wrong := url.Values{"csrf": {loginCSRF}, "username": {username}, "password": {"wrong password value"}}
	post(throttled, "/login", wrong, http.StatusUnauthorized)
	post(throttled, "/login", wrong, http.StatusTooManyRequests)

	fmt.Println("WSL smoke flow passed")
}

func verifyPersistence() {
	client := newClient()
	loginPage := get(client, "/login", http.StatusOK)
	publicCSRF := extract(csrfPattern, loginPage, "login CSRF")
	post(client, "/login", url.Values{
		"csrf": {publicCSRF}, "username": {username}, "password": {password},
	}, http.StatusSeeOther)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		dashboard := get(client, "/", http.StatusOK)
		if strings.Contains(dashboard, "healthy") {
			fmt.Println("WSL persistence smoke passed")
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	fatalf("persisted Veil configuration did not become healthy")
}

func newClient() *http.Client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		fatalf("create cookie jar: %v", err)
	}
	return &http.Client{Jar: jar, Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

func get(client *http.Client, path string, want int) string {
	response, err := client.Get(consoleURL + path)
	if err != nil {
		fatalf("GET %s: %v", path, err)
	}
	return responseBody(response, want, "GET "+path)
}

func post(client *http.Client, path string, values url.Values, want int) string {
	request, err := http.NewRequest(http.MethodPost, consoleURL+path, strings.NewReader(values.Encode()))
	if err != nil {
		fatalf("create POST %s: %v", path, err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", consoleURL)
	response, err := client.Do(request)
	if err != nil {
		fatalf("POST %s: %v", path, err)
	}
	return responseBody(response, want, "POST "+path)
}

func responseBody(response *http.Response, want int, action string) string {
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		fatalf("%s response: %v", action, err)
	}
	if response.StatusCode != want {
		fatalf("%s returned %d, want %d: %s", action, response.StatusCode, want, payload)
	}
	return string(payload)
}

func extract(pattern *regexp.Regexp, text, label string) string {
	match := pattern.FindStringSubmatch(text)
	if len(match) != 2 || match[1] == "" {
		fatalf("%s is missing", label)
	}
	return match[1]
}

func sessionCSRF(client *http.Client) string {
	parsed, _ := url.Parse(consoleURL)
	for _, cookie := range client.Jar.Cookies(parsed) {
		if cookie.Name == "veil_console_csrf" {
			return cookie.Value
		}
	}
	fatalf("session CSRF cookie is missing")
	return ""
}

func settingsValues(csrf, providerURL string) url.Values {
	return url.Values{
		"csrf": {csrf}, "protocol": {"vllm"}, "provider_base_url": {providerURL}, "model": {"fake-model"},
		"context_length": {"0"}, "max_output_tokens": {"8192"}, "model_timeout": {"10s"},
		"request_timeout": {"15s"}, "max_body_bytes": {"67108864"},
	}
}

func waitForHealth(token string) {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		request, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/health", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := (&http.Client{Timeout: time.Second}).Do(request)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	fatalf("Veil did not become healthy")
}

func fatalf(format string, values ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", values...)
	os.Exit(1)
}
