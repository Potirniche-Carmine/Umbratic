// Package localhttp builds the one HTTP client Console is allowed to point at
// a service on the box: no proxy, no redirects, and a dialer that refuses any
// address outside loopback and private ranges. Cloud metadata endpoints and
// link-local addresses are rejected before the connection is made and again
// after it is established, so a DNS answer that changes between the two checks
// still cannot reach a public address.
package localhttp

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"
)

func Client(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirects are not allowed")
		},
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           dialPrivate,
			MaxIdleConns:          32,
			MaxIdleConnsPerHost:   16,
			IdleConnTimeout:       60 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: timeout,
			ForceAttemptHTTP2:     false,
		},
	}
}

func AllowedIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}

func dialPrivate(ctx context.Context, network, destination string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(destination)
	if err != nil {
		return nil, errors.New("destination is invalid")
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	addresses := []net.IPAddr{}
	if ip := net.ParseIP(host); ip != nil {
		addresses = append(addresses, net.IPAddr{IP: ip})
	} else {
		resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(resolved) == 0 {
			return nil, errors.New("host could not be resolved")
		}
		addresses = resolved
	}
	var lastErr error = errors.New("host must resolve only to loopback or private addresses")
	for _, address := range addresses {
		if !AllowedIP(address.IP) {
			continue
		}
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
		if dialErr != nil {
			lastErr = dialErr
			continue
		}
		remote, ok := conn.RemoteAddr().(*net.TCPAddr)
		if !ok || !AllowedIP(remote.IP) {
			_ = conn.Close()
			lastErr = errors.New("connection reached a disallowed address")
			continue
		}
		return conn, nil
	}
	return nil, lastErr
}
