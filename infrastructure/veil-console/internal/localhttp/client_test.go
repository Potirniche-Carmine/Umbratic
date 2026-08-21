package localhttp

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAllowedIPPermitsLoopbackAndPrivateAndRefusesTheRest(t *testing.T) {
	for _, testCase := range []struct {
		ip   string
		want bool
	}{
		{ip: "127.0.0.1", want: true},
		{ip: "::1", want: true},
		{ip: "10.0.0.8", want: true},
		{ip: "192.168.1.20", want: true},
		{ip: "172.16.0.4", want: true},
		{ip: "8.8.8.8", want: false},
		{ip: "1.1.1.1", want: false},
		{ip: "169.254.169.254", want: false},
		{ip: "0.0.0.0", want: false},
		{ip: "224.0.0.1", want: false},
		{ip: "fe80::1", want: false},
	} {
		got := AllowedIP(net.ParseIP(testCase.ip))
		if got != testCase.want {
			t.Errorf("AllowedIP(%s) = %v, want %v", testCase.ip, got, testCase.want)
		}
	}
	if AllowedIP(nil) {
		t.Fatal("a nil IP must be refused")
	}
}

func TestClientRefusesRedirects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, "/elsewhere", http.StatusFound)
	}))
	t.Cleanup(server.Close)

	response, err := Client(2 * time.Second).Get(server.URL)
	if err == nil {
		response.Body.Close()
		t.Fatal("a redirect was followed")
	}
	if !strings.Contains(err.Error(), "redirects are not allowed") {
		t.Fatalf("wrong refusal: %v", err)
	}
}

func TestClientRefusesPublicAddressesWithoutDialingThem(t *testing.T) {
	response, err := Client(2 * time.Second).Get("http://8.8.8.8/")
	if err == nil {
		response.Body.Close()
		t.Fatal("a public address was accepted")
	}
	if !strings.Contains(err.Error(), "loopback or private") {
		t.Fatalf("wrong refusal: %v", err)
	}
}

func TestClientReachesLoopback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(writer, "ok")
	}))
	t.Cleanup(server.Close)

	response, err := Client(2 * time.Second).Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != "ok" {
		t.Fatalf("loopback GET = %q, %v", body, err)
	}
}
