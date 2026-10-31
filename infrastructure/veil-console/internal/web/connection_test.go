package web

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/supervisor"
)

func TestConnectionFormRequiresSessionAndCSRF(t *testing.T) {
	server, handler, cookies, csrf, cleanup := signedInConsole(t)
	defer cleanup()
	c := config.DefaultConnection()
	server.proxy = supervisor.NewProxy("unavailable", server.startup.StateDir, server.startup.VeilAddress, server.startup.Port, c)
	defer server.proxy.Stop()
	values := url.Values{"host": {"host\nrespond 200"}, "port": {"8432"}, "tls": {"internal"}, "csrf": {csrf}}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, formRequest(http.MethodPost, "/connection", values))
	if response.Code != http.StatusSeeOther {
		t.Fatalf("anonymous write: %d", response.Code)
	}
	values.Set("csrf", "wrong")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, formRequest(http.MethodPost, "/connection", values, cookies...))
	if response.Code != http.StatusForbidden {
		t.Fatalf("CSRF bypass: %d", response.Code)
	}
	values.Set("csrf", csrf)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, formRequest(http.MethodPost, "/connection", values, cookies...))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid config accepted: %d", response.Code)
	}
	saved, err := server.store.Connection(context.Background())
	if err != nil || saved != c {
		t.Fatalf("failed write changed state: %+v %v", saved, err)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, formRequest(http.MethodGet, "/", nil, cookies...))
	for _, text := range []string{`action="/connection"`, `value="localhost"`, "Local access only", "Private / VPN"} {
		if !strings.Contains(response.Body.String(), text) {
			t.Errorf("dashboard missing %s", text)
		}
	}
}
func TestEnrollmentUsesCurrentHTTPSAddressAndCertificate(t *testing.T) {
	binary := os.Getenv("UMBRATIC_TEST_CADDY_BINARY")
	if binary == "" {
		t.Skip("set UMBRATIC_TEST_CADDY_BINARY for HTTPS enrollment")
	}
	server, cleanup := testServer(t)
	defer cleanup()
	c := config.DefaultConnection()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	c.Port = listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	server.proxy = supervisor.NewProxy(binary, server.startup.StateDir, server.startup.VeilAddress, server.startup.Port, c)
	defer server.proxy.Stop()
	if _, err := server.enrollmentMaterial("test-code"); err == nil {
		t.Fatal("enrollment advertised unready endpoint")
	}
	if err := server.proxy.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	c.Host = "127.0.0.1"
	if err := server.proxy.Apply(context.Background(), c, func(c config.Connection) error { return server.store.SaveConnection(context.Background(), c) }); err != nil {
		t.Fatal(err)
	}
	material, err := server.enrollmentMaterial("test-code")
	if err != nil {
		t.Fatal(err)
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(material, "umbr_enroll1_"))
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]string
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	if value["url"] != c.URL() || value["code"] != "test-code" || !strings.Contains(value["ca"], "BEGIN CERTIFICATE") {
		t.Fatal("enrollment did not contain active address, code, and public certificate")
	}
	if strings.Contains(string(data), "PRIVATE KEY") {
		t.Fatal("private key exposed")
	}
}
