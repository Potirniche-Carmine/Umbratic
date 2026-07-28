package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"umbratic-veil-console/internal/config"
)

func TestProvider(ctx context.Context, cfg config.Veil) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	models, err := ListModels(ctx, cfg.Protocol, cfg.ProviderBaseURL)
	if err != nil {
		return err
	}
	for _, model := range models {
		if model == cfg.Model {
			return nil
		}
	}
	return errors.New("selected model is not available")
}

func ListModels(ctx context.Context, protocol, providerBaseURL string) ([]string, error) {
	cfg := config.DefaultVeil()
	cfg.Protocol, cfg.ProviderBaseURL, cfg.Model = protocol, strings.TrimSpace(providerBaseURL), "model"
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
	path := "/v1/models"
	if cfg.Protocol == "ollama" {
		path = "/api/tags"
	}
	base.Path = providerPath(base.Path, path)
	request, _ := http.NewRequestWithContext(testCtx, http.MethodGet, base.String(), nil)
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("provider health test failed")
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

func providerPath(basePath, endpoint string) string {
	basePath = strings.TrimRight(basePath, "/")
	lastSlash := strings.LastIndex(endpoint, "/")
	if lastSlash > 0 && strings.HasSuffix(basePath, endpoint[:lastSlash]) {
		return basePath + endpoint[lastSlash:]
	}
	return basePath + endpoint
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

func containsModel(payload []byte, selected string) bool {
	for _, model := range collectModels(payload) {
		if model == selected {
			return true
		}
	}
	return false
}

func allowedProviderIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}
