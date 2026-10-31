package config

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// Connection is the employee endpoint. Console and Veil still bind to loopback.
type Connection struct {
	Host string
	Port int
	TLS  string
}

func DefaultConnection() Connection {
	return Connection{Host: "localhost", Port: 8432, TLS: "internal"}
}
func (c Connection) URL() string { return "https://" + net.JoinHostPort(c.Host, strconv.Itoa(c.Port)) }
func (c Connection) LocalOnly() bool {
	ip := net.ParseIP(c.Host)
	return c.Host == "localhost" || ip != nil && ip.IsLoopback()
}

var connectionLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func (c Connection) Validate(reserved ...int) error {
	if c.Host != strings.ToLower(strings.TrimSpace(c.Host)) || len(c.Host) > 253 || c.Host == "" {
		return errors.New("enter a hostname or IPv4 address")
	}
	if ip := net.ParseIP(c.Host); ip != nil {
		if ip.IsLoopback() && c.Host != "127.0.0.1" {
			return errors.New("use localhost or 127.0.0.1 for local access")
		}
		if ip.To4() == nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() {
			return errors.New("enter a reachable IPv4 address")
		}
	} else {
		for _, label := range strings.Split(c.Host, ".") {
			if !connectionLabel.MatchString(label) {
				return errors.New("enter a hostname without a scheme, path, or port")
			}
		}
	}
	if c.Port < 1024 || c.Port > 65535 {
		return errors.New("HTTPS port must be between 1024 and 65535")
	}
	for _, port := range append(reserved, 6333, 6334) {
		if c.Port == port {
			return fmt.Errorf("port %d is reserved for another service", port)
		}
	}
	if c.TLS != "internal" && c.TLS != "public" {
		return errors.New("select private or public certificates")
	}
	if c.TLS == "public" && (net.ParseIP(c.Host) != nil || !strings.Contains(c.Host, ".") || strings.HasSuffix(c.Host, ".local") || c.LocalOnly()) {
		return errors.New("public certificates require a publicly validatable DNS name")
	}
	return nil
}

// Values reach this generator only after Validate. No browser-supplied Caddy
// directives, executable arguments, or filesystem paths are accepted.
func (c Connection) Caddyfile(veilAddress string) string {
	tls, bind := "tls {\n  issuer acme {\n   disable_http_challenge\n  }\n }", ""
	if c.TLS == "internal" {
		tls = "tls internal"
	}
	if c.LocalOnly() {
		bind = "bind 127.0.0.1"
	}
	return fmt.Sprintf(`{
 admin off
 https_port %d
 skip_install_trust
 auto_https disable_redirects
}
%s {
 %s
 %s
 @control path /api/control /api/control/*
 respond @control 404
 reverse_proxy %s {
  flush_interval -1
  transport http {
   response_header_timeout 5m
  }
 }
}
`, c.Port, c.URL(), tls, bind, veilAddress)
}
