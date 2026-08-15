package model

import (
	"context"
	"errors"
	"fmt"
	"net/http"
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
}

func NewRegistry(mode Mode, defaultID string, apiKey string, specs []RegistrySpec, timeout time.Duration) (*Registry, error) {
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
			APIKey:           apiKey,
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

// resolveThinking drops a thinking directive for a model that has no thinking
// to direct. `chat_template_kwargs.enable_thinking` reaches a chat template
// that may not read it, so sending it unasked would be a silent no-op that
// still reads, in a trace, as a directive that was honoured.
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
// this model. Both modes answer from the declaration that came with the spec:
// server entries from the administrator's registry, local entries from the
// model catalog the desktop downloaded the weights out of. Neither runtime
// exposes the capability, and a wrong guess is worse than a stated fact.
func (r *Registry) ThinkingSupported(_ context.Context, modelID string) bool {
	entry, ok := r.entries[modelID]
	if !ok {
		return false
	}
	return entry.spec.Reasoning
}
