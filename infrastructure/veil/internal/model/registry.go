package model

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RegistrySpec describes one routable model. One Client is built per spec and
// kept for the process lifetime, so every endpoint a request can reach is
// resolved once at startup rather than assembled from a per-request base URL.
type RegistrySpec struct {
	ID               string
	BaseURL          string
	ContextLength    int
	Reasoning        bool
	EmbeddingBaseURL string
	EmbeddingModel   string
}

type registryEntry struct {
	spec   RegistrySpec
	client *Client
}

// Registry routes model work by model id. With one spec it behaves exactly like
// the single Client it replaces: every method lands on the same endpoints.
type Registry struct {
	mode      Mode
	defaultID string
	order     []string
	entries   map[string]*registryEntry
	// thinkingSupport caches the local runtime's answer per model id. The probe
	// is an extra round trip, and the answer only changes when the administrator
	// pulls a different build of the same tag.
	thinkingSupport sync.Map
}

func NewRegistry(mode Mode, defaultID string, specs []RegistrySpec, timeout time.Duration) (*Registry, error) {
	if len(specs) == 0 {
		return nil, errors.New("model registry requires at least one model")
	}
	registry := &Registry{
		mode:      mode,
		defaultID: defaultID,
		entries:   make(map[string]*registryEntry, len(specs)),
	}
	for _, spec := range specs {
		if _, exists := registry.entries[spec.ID]; exists {
			return nil, fmt.Errorf("model registry lists id %q twice", spec.ID)
		}
		client, err := NewClient(ClientConfig{
			Mode:             mode,
			BaseURL:          spec.BaseURL,
			ContextLength:    spec.ContextLength,
			Timeout:          timeout,
			EmbeddingBaseURL: spec.EmbeddingBaseURL,
			EmbeddingModel:   spec.EmbeddingModel,
		})
		if err != nil {
			return nil, err
		}
		registry.order = append(registry.order, spec.ID)
		registry.entries[spec.ID] = &registryEntry{spec: spec, client: client}
	}
	if _, ok := registry.entries[defaultID]; !ok {
		return nil, fmt.Errorf("model registry has no entry for default model %q", defaultID)
	}
	return registry, nil
}

func (r *Registry) clientFor(modelID string) *Client {
	if entry, ok := r.entries[modelID]; ok {
		return entry.client
	}
	return r.entries[r.defaultID].client
}

// DefaultClient is the client for the configured default model. Work that is
// not tied to a request's model — runtime metrics, embeddings — uses it.
func (r *Registry) DefaultClient() *Client { return r.clientFor(r.defaultID) }

func (r *Registry) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	return r.clientFor(req.Model).Chat(ctx, r.resolveThinking(ctx, req))
}

func (r *Registry) DoChat(ctx context.Context, req ChatRequest) (*http.Response, error) {
	return r.clientFor(req.Model).DoChat(ctx, r.resolveThinking(ctx, req))
}

// resolveThinking drops a thinking directive the local runtime cannot carry.
// Some Ollama builds error on `think` for a model without the capability, so an
// unconfirmed capability means the field is omitted rather than guessed.
func (r *Registry) resolveThinking(ctx context.Context, req ChatRequest) ChatRequest {
	if req.Thinking == nil || r.mode != ModeLocal {
		return req
	}
	if !r.ThinkingSupported(ctx, req.Model) {
		req.Thinking = nil
	}
	return req
}

func (r *Registry) ListModels(ctx context.Context) ([]ModelInfo, error) {
	return r.DefaultClient().ListModels(ctx)
}

func (r *Registry) ActivateModel(ctx context.Context, modelID string) error {
	return r.clientFor(modelID).ActivateModel(ctx, modelID)
}

func (r *Registry) ContextLength(ctx context.Context, modelID string) (int, error) {
	return r.clientFor(modelID).ContextLength(ctx, modelID)
}

func (r *Registry) RuntimeMetrics(ctx context.Context) (RuntimeMetrics, error) {
	return r.DefaultClient().RuntimeMetrics(ctx)
}

func (r *Registry) PrefixTokens(ctx context.Context, key, modelID string, messages []Message) UsageAnnotation {
	return r.clientFor(modelID).PrefixTokens(ctx, key, modelID, messages)
}

func (r *Registry) Embed(ctx context.Context, text string) ([]float32, error) {
	return r.DefaultClient().Embed(ctx, text)
}

// Available reports whether the runtime behind this id currently lists it. It
// is the live half of /api/models: registration is configuration, availability
// is whatever the process on that port says right now.
func (r *Registry) Available(ctx context.Context, modelID string) (bool, error) {
	entry, ok := r.entries[modelID]
	if !ok {
		return false, nil
	}
	models, err := entry.client.ListModels(ctx)
	if err != nil {
		return false, err
	}
	for _, available := range models {
		if available.ID == modelID {
			return true, nil
		}
	}
	return false, nil
}

// ThinkingSupported answers whether a thinking directive means anything for
// this model. Server entries answer from the administrator's declaration;
// local entries ask the runtime, because Ollama knows and the admin may not.
func (r *Registry) ThinkingSupported(ctx context.Context, modelID string) bool {
	entry, ok := r.entries[modelID]
	if !ok {
		return false
	}
	if r.mode != ModeLocal {
		return entry.spec.Reasoning
	}
	if cached, ok := r.thinkingSupport.Load(modelID); ok {
		return cached.(bool)
	}
	supported := entry.client.thinkingCapable(ctx, modelID)
	r.thinkingSupport.Store(modelID, supported)
	return supported
}

// thinkingCapable asks Ollama what the model can do. A probe failure is read as
// "not supported": sending `think` to a runtime that rejects it fails the turn,
// while omitting it only loses a directive.
func (c *Client) thinkingCapable(ctx context.Context, modelID string) bool {
	if c.mode != ModeLocal || c.showEndpoint == "" {
		return false
	}
	resp, err := c.postJSON(ctx, c.showEndpoint, map[string]any{"model": modelID})
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false
	}
	var payload any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return false
	}
	return ollamaCapabilitiesFromPayload(payload)["thinking"]
}

// ollamaCapabilitiesFromPayload reads the capability list from an api/show
// response. Unknown capability names are kept: this build only asks about
// thinking, but the set is what the runtime said, not what this build knows.
func ollamaCapabilitiesFromPayload(payload any) map[string]bool {
	capabilities := map[string]bool{}
	record, ok := payload.(map[string]any)
	if !ok {
		return capabilities
	}
	rows, ok := record["capabilities"].([]any)
	if !ok {
		return capabilities
	}
	for _, row := range rows {
		name, ok := row.(string)
		if !ok {
			continue
		}
		name = strings.ToLower(strings.TrimSpace(name))
		if name != "" {
			capabilities[name] = true
		}
	}
	return capabilities
}
