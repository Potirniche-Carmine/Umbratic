package config

import (
	"strings"
	"testing"
)

func TestConnectionRejectsUnsafeAddressesAndPorts(t *testing.T) {
	for _, host := range []string{"https://server", "host:8432", "host/path", "host\nrespond 200", "{env.SECRET}", "*.example.com", "-host", "a..b", "0.0.0.0", "169.254.169.254", "127.0.0.2", "::1"} {
		c := DefaultConnection()
		c.Host = host
		if c.Validate(8080, 8177) == nil {
			t.Errorf("accepted %q", host)
		}
	}
	for _, port := range []int{0, 443, 8080, 8177, 6333, 6334, 65536} {
		c := DefaultConnection()
		c.Port = port
		if c.Validate(8080, 8177) == nil {
			t.Errorf("accepted port %d", port)
		}
	}
	for _, host := range []string{"localhost", "10.20.0.5", "veil.local"} {
		c := DefaultConnection()
		c.Host = host
		if err := c.Validate(); err != nil {
			t.Fatal(err)
		}
		c.TLS = "public"
		if c.Validate() == nil {
			t.Errorf("accepted public certificates for %s", host)
		}
	}
}
func TestLocalConnectionBindsOnlyLoopback(t *testing.T) {
	c := DefaultConnection()
	text := c.Caddyfile("127.0.0.1:8080")
	for _, part := range []string{"bind 127.0.0.1", "tls internal", "admin off", "respond @control 404", "reverse_proxy 127.0.0.1:8080"} {
		if !strings.Contains(text, part) {
			t.Errorf("missing %s", part)
		}
	}
	c.Host = "10.20.0.5"
	if c.URL() != "https://10.20.0.5:8432" || c.LocalOnly() {
		t.Fatal("VPN address misclassified")
	}
}
