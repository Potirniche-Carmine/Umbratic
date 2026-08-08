package rag

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"umbratic-veil/internal/model"
)

// Qdrant is plain JSON over HTTP on loopback, so this is the whole client: one
// search call, bounded, with the same hardened transport the model runtime is
// reached through.
const (
	maxResponseBytes = 4 << 20
	maxChunkBytes    = 16 << 10
)

type VectorStore struct {
	endpoint string
	apiKey   string
	client   *http.Client
}

type Chunk struct {
	DocName string
	Section string
	Text    string
	Score   float64
}

func NewVectorStore(baseURL, apiKey, collection string, timeout time.Duration) (*VectorStore, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("vector base URL is invalid")
	}
	collection = strings.TrimSpace(collection)
	if collection == "" || strings.ContainsAny(collection, "/?#\r\n") {
		return nil, errors.New("vector collection is invalid")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/collections/" + collection + "/points/query"
	parsed.RawQuery, parsed.Fragment = "", ""
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	return &VectorStore{
		endpoint: parsed.String(),
		apiKey:   strings.TrimSpace(apiKey),
		client:   model.HardenedHTTPClient(timeout),
	}, nil
}

// Query returns the highest-scoring chunks that pass the filter. Payload
// fields are read defensively: the payload is data Console wrote, but it is
// still parsed as untrusted and bounded before it can reach a prompt.
func (v *VectorStore) Query(ctx context.Context, vector []float32, filter map[string]any, limit int) ([]Chunk, error) {
	payload, err := json.Marshal(map[string]any{
		"query":        vector,
		"filter":       filter,
		"limit":        limit,
		"with_payload": true,
	})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, v.endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if v.apiKey != "" {
		request.Header.Set("api-key", v.apiKey)
	}
	response, err := v.client.Do(request)
	if err != nil {
		return nil, errors.New("vector database request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, errors.New("vector database returned an error status")
	}
	var decoded struct {
		Result struct {
			Points []struct {
				Score   float64        `json:"score"`
				Payload map[string]any `json:"payload"`
			} `json:"points"`
		} `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes)).Decode(&decoded); err != nil {
		return nil, errors.New("vector database returned an unreadable response")
	}
	chunks := make([]Chunk, 0, len(decoded.Result.Points))
	for _, point := range decoded.Result.Points {
		text := payloadString(point.Payload, "text", maxChunkBytes)
		if strings.TrimSpace(text) == "" {
			continue
		}
		chunks = append(chunks, Chunk{
			DocName: payloadString(point.Payload, "doc_name", 200),
			Section: payloadString(point.Payload, "section", 120),
			Text:    text,
			Score:   point.Score,
		})
	}
	return chunks, nil
}

func payloadString(payload map[string]any, key string, limit int) string {
	value, _ := payload[key].(string)
	value = strings.ToValidUTF8(value, "")
	value = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, value)
	if len(value) <= limit {
		return value
	}
	for limit > 0 && value[limit]&0xC0 == 0x80 {
		limit--
	}
	return value[:limit]
}
