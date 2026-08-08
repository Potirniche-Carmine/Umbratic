package rag

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"umbratic-veil-console/internal/localhttp"
)

// The embedding runtime is a second vLLM instance in pooling mode, or any
// service that speaks the same OpenAI-shaped `/v1/embeddings` API. Console only
// ever calls it on a private address, and only while an administrator is
// configuring or an upload is being indexed — never on a chat request.
const (
	embedBatchSize    = 16
	embedTimeout      = 120 * time.Second
	embedResponseCap  = 64 << 20
	maxEmbeddingBytes = 32 << 10
)

type Embedder struct {
	endpoint string
	model    string
	client   *http.Client
}

func NewEmbedder(baseURL, model string) (*Embedder, error) {
	endpoint, err := embeddingsEndpoint(baseURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(model) == "" {
		return nil, errors.New("an embedding model is required")
	}
	return &Embedder{endpoint: endpoint, model: model, client: localhttp.Client(embedTimeout)}, nil
}

// embeddingsEndpoint resolves the request URL from a configured base, whether
// or not the administrator included the `/v1` prefix.
func embeddingsEndpoint(baseURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", errors.New("embedding runtime URL is invalid")
	}
	path := strings.TrimRight(parsed.Path, "/")
	switch {
	case strings.HasSuffix(path, "/embeddings"):
	case strings.HasSuffix(path, "/v1"):
		path += "/embeddings"
	default:
		path += "/v1/embeddings"
	}
	parsed.Path, parsed.RawQuery, parsed.Fragment = path, "", ""
	return parsed.String(), nil
}

// Probe embeds one short string to prove the endpoint answers and to learn the
// vector dimension the collection must be created with.
func (e *Embedder) Probe(ctx context.Context) (int, error) {
	vectors, err := e.Embed(ctx, []string{"umbratic embedding probe"})
	if err != nil {
		return 0, err
	}
	if len(vectors) != 1 || len(vectors[0]) == 0 {
		return 0, errors.New("the embedding runtime returned no vector")
	}
	return len(vectors[0]), nil
}

// Embed returns one vector per input, in input order, batching so a large
// document does not become one enormous request.
func (e *Embedder) Embed(ctx context.Context, inputs []string) ([][]float32, error) {
	vectors := make([][]float32, 0, len(inputs))
	for start := 0; start < len(inputs); start += embedBatchSize {
		end := min(start+embedBatchSize, len(inputs))
		batch := make([]string, 0, end-start)
		for _, input := range inputs[start:end] {
			batch = append(batch, boundedInput(input))
		}
		batchVectors, err := e.embedBatch(ctx, batch)
		if err != nil {
			return nil, err
		}
		if len(batchVectors) != len(batch) {
			return nil, errors.New("the embedding runtime returned the wrong number of vectors")
		}
		vectors = append(vectors, batchVectors...)
	}
	return vectors, nil
}

func boundedInput(text string) string {
	if len(text) <= maxEmbeddingBytes {
		return text
	}
	cut := maxEmbeddingBytes
	for cut > 0 && !isRuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

func (e *Embedder) embedBatch(ctx context.Context, inputs []string) ([][]float32, error) {
	payload, err := json.Marshal(map[string]any{"model": e.model, "input": inputs})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, e.endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := e.client.Do(request)
	if err != nil {
		return nil, errors.New("the embedding runtime could not be reached")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("the embedding runtime returned status %d", response.StatusCode)
	}
	var decoded struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, embedResponseCap)).Decode(&decoded); err != nil {
		return nil, errors.New("the embedding runtime returned an unreadable response")
	}
	vectors := make([][]float32, len(decoded.Data))
	for _, row := range decoded.Data {
		index := row.Index
		if index < 0 || index >= len(vectors) {
			return nil, errors.New("the embedding runtime returned an out-of-range index")
		}
		if len(row.Embedding) == 0 {
			return nil, errors.New("the embedding runtime returned an empty vector")
		}
		vectors[index] = row.Embedding
	}
	for _, vector := range vectors {
		if vector == nil {
			return nil, errors.New("the embedding runtime skipped an input")
		}
	}
	return vectors, nil
}
