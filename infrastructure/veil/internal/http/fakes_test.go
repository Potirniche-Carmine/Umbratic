package httpapi

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"time"

	"umbratic-veil/internal/config"
	"umbratic-veil/internal/model"
)

type fakeModelClient struct {
	req               model.ChatRequest
	models            []model.ModelInfo
	chatErr           error
	chatContent       string
	listErr           error
	streamErr         error
	streamStatusCode  int
	streamContentType string
	streamBody        string
	activateErr       error
	activatedModel    string
	contextLength     int
	contextErr        error
	runtimeMetrics    model.RuntimeMetrics
	runtimeMetricsErr error
	prefixTokenCalls  int
	embedding         []float32
	embedErr          error
	embedCalls        int
	embedQuery        string
	available         map[string]bool
	availableErr      error
	availableCalls    []string
	thinkingSupported map[string]bool
}

func (f *fakeModelClient) Embed(_ context.Context, text string) ([]float32, error) {
	f.embedCalls++
	f.embedQuery = text
	if f.embedErr != nil {
		return nil, f.embedErr
	}
	if f.embedding == nil {
		return []float32{0.1, 0.2, 0.3}, nil
	}
	return f.embedding, nil
}

func (f *fakeModelClient) RuntimeMetrics(context.Context) (model.RuntimeMetrics, error) {
	return f.runtimeMetrics, f.runtimeMetricsErr
}

func (f *fakeModelClient) ActivateModel(ctx context.Context, modelID string) error {
	f.activatedModel = modelID
	return f.activateErr
}

func (f *fakeModelClient) ContextLength(ctx context.Context, modelID string) (int, error) {
	if f.contextErr != nil {
		return 0, f.contextErr
	}
	if f.contextLength > 0 {
		return f.contextLength, nil
	}
	return 131072, nil
}

func (f *fakeModelClient) Chat(ctx context.Context, req model.ChatRequest) (model.ChatResponse, error) {
	f.req = req
	if f.chatErr != nil {
		return model.ChatResponse{}, f.chatErr
	}
	content := f.chatContent
	if content == "" {
		content = "ok"
	}
	return model.ChatResponse{Message: model.Message{Role: "assistant", Content: content}}, nil
}

func (f *fakeModelClient) DoChat(ctx context.Context, req model.ChatRequest) (*http.Response, error) {
	f.req = req
	if f.streamErr != nil {
		return nil, f.streamErr
	}
	statusCode := f.streamStatusCode
	if statusCode == 0 {
		statusCode = http.StatusOK
	}
	contentType := f.streamContentType
	if contentType == "" {
		contentType = "text/event-stream"
	}
	body := f.streamBody
	if body == "" {
		body = "data: [DONE]\n\n"
	}
	return &http.Response{
		StatusCode: statusCode,
		Header:     http.Header{"Content-Type": []string{contentType}},
		Body:       io.NopCloser(bytes.NewBufferString(body)),
	}, nil
}

func (f *fakeModelClient) Available(ctx context.Context, modelID string) (bool, error) {
	f.availableCalls = append(f.availableCalls, modelID)
	if f.availableErr != nil {
		return false, f.availableErr
	}
	if f.available != nil {
		return f.available[modelID], nil
	}
	models, err := f.ListModels(ctx)
	if err != nil {
		return false, err
	}
	for _, candidate := range models {
		if candidate.ID == modelID {
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeModelClient) ThinkingSupported(_ context.Context, modelID string) bool {
	return f.thinkingSupported[modelID]
}

func (f *fakeModelClient) ListModels(ctx context.Context) ([]model.ModelInfo, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	if f.models == nil {
		return []model.ModelInfo{{ID: "default-model"}}, nil
	}
	return f.models, nil
}

func testConfig() config.Config {
	return config.Config{
		Addr:                   "127.0.0.1:0",
		AuthToken:              "test-token",
		Mode:                   model.ModeServer,
		DefaultModel:           "default-model",
		Models:                 []config.ModelEntry{{ID: "default-model", ProviderBaseURL: "http://provider.test"}},
		RequestTimeout:         time.Second,
		StreamIdleTimeout:      time.Second,
		MaxBodyBytes:           1 << 20,
		MaxOutputTokens:        4096,
		ModelParallelToolCalls: true,
		Generation: model.GenerationProfile{
			Temperature:               0.2,
			TopP:                      0.95,
			MaxOutputTokens:           4096,
			ReasoningEffort:           model.ReasoningNone,
			ParallelToolCalls:         true,
			MaxConcurrentRequests:     32,
			MaxConcurrentRequestsUser: 4,
			QueueTimeout:              30 * time.Second,
		},
	}
}
