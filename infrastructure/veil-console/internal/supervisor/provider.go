package supervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"time"

	"umbratic-veil-console/internal/config"
)

func TestProvider(ctx context.Context, cfg config.Veil) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	models, err := ListModels(ctx, cfg.ProviderBaseURL)
	if err != nil {
		return err
	}
	found := false
	for _, model := range models {
		if model == cfg.Model {
			found = true
			break
		}
	}
	if !found {
		return errors.New("selected model is not available")
	}
	// Listing the model is not proof it can generate. Probe the paths the runner
	// actually depends on before a configuration is accepted.
	return probeGeneration(ctx, cfg)
}

func ListModels(ctx context.Context, providerBaseURL string) ([]string, error) {
	cfg := config.DefaultVeil()
	cfg.ProviderBaseURL, cfg.Model = strings.TrimSpace(providerBaseURL), "model"
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	payload, err := providerPayload(ctx, cfg)
	if err != nil {
		return nil, err
	}
	models := collectModels(payload)
	if len(models) == 0 {
		return nil, errors.New("runtime did not return any models")
	}
	return models, nil
}

func providerPayload(ctx context.Context, cfg config.Veil) ([]byte, error) {
	return providerRequest(ctx, cfg, "/v1/models", nil)
}

// providerRequest performs one guarded call to the runtime. The host must
// resolve only to loopback or private addresses, redirects are refused, and both
// the body and the response are bounded.
func providerRequest(ctx context.Context, cfg config.Veil, endpoint string, body []byte) ([]byte, error) {
	testCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	base, _ := url.Parse(cfg.ProviderBaseURL)
	addresses, err := net.DefaultResolver.LookupIPAddr(testCtx, base.Hostname())
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("provider host could not be resolved")
	}
	for _, address := range addresses {
		if !allowedProviderIP(address.IP) {
			return nil, errors.New("provider host must resolve only to loopback or private addresses")
		}
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(dialCtx context.Context, network, destination string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(destination)
			if err != nil {
				return nil, errors.New("provider destination is invalid")
			}
			for _, address := range addresses {
				conn, dialErr := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(
					dialCtx, network, net.JoinHostPort(address.IP.String(), port),
				)
				if dialErr == nil {
					return conn, nil
				}
			}
			return nil, errors.New("provider connection failed")
		},
		TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 5 * time.Second,
	}
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("provider redirects are not allowed")
	}}
	base.Path = providerPath(base.Path, endpoint)
	method := http.MethodGet
	var reader io.Reader
	if body != nil {
		method, reader = http.MethodPost, bytes.NewReader(body)
	}
	request, _ := http.NewRequestWithContext(testCtx, method, base.String(), reader)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("provider health test failed")
	}
	if body != nil {
		return drainProbeResponse(response)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, errors.New("provider health test failed")
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil || !json.Valid(payload) {
		return nil, errors.New("provider returned an invalid response")
	}
	return payload, nil
}

// providerPath joins a configured base path with an endpoint path without
// repeating the part they share. The overlap is measured in whole segments:
// matching only the endpoint's parent directory meant a base of `/v1` joined
// `/v1/models` correctly but turned `/v1/chat/completions` into
// `/v1/v1/chat/completions`, so the generation probes 404'd on the default
// configuration while the model listing looked fine.
func providerPath(basePath, endpoint string) string {
	baseSegments := pathSegments(basePath)
	endpointSegments := pathSegments(endpoint)
	overlap := min(len(baseSegments), len(endpointSegments))
	for ; overlap > 0; overlap-- {
		if slices.Equal(baseSegments[len(baseSegments)-overlap:], endpointSegments[:overlap]) {
			break
		}
	}
	joined := append(baseSegments, endpointSegments[overlap:]...)
	return "/" + strings.Join(joined, "/")
}

func pathSegments(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func collectModels(payload []byte) []string {
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return nil
	}
	models := map[string]struct{}{}
	var visit func(any)
	visit = func(current any) {
		switch typed := current.(type) {
		case map[string]any:
			for key, child := range typed {
				if key == "id" || key == "name" || key == "model" {
					if model, ok := child.(string); ok && validModelID(model) {
						models[model] = struct{}{}
					}
				}
				visit(child)
			}
		case []any:
			for _, child := range typed {
				visit(child)
			}
		}
	}
	visit(value)
	result := make([]string, 0, len(models))
	for model := range models {
		result = append(result, model)
	}
	sort.Strings(result)
	return result
}

func validModelID(value string) bool {
	return value != "" && len(value) <= 256 && !strings.ContainsAny(value, "\r\n\x00")
}

func allowedProviderIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}
