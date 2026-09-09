package deployment

import (
	"os"
	"testing"
	"umbratic-veil-console/internal/config"
)

func TestGeneratedConfigurationWithBundledCaddy(t *testing.T) {
	binary := os.Getenv("UMBRATIC_TEST_CADDY_BINARY")
	if binary == "" {
		t.Skip("set UMBRATIC_TEST_CADDY_BINARY to validate with the release Caddy")
	}
	for _, c := range []config.Connection{
		config.DefaultConnection(),
		{Host: "10.20.0.5", Port: 9443, TLS: "internal"},
		{Host: "veil.example.com", Port: 9443, TLS: "public"},
	} {
		if err := checkCaddyConfiguration(binary, c, 8080); err != nil {
			t.Fatalf("%+v: %v", c, err)
		}
	}
}
