package rag

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
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

// Qdrant speaks plain JSON over HTTP on loopback, so Console talks to it with
// the standard library and no client dependency. Console owns writes; Veil owns
// the one read that matters at request time.
const (
	qdrantTimeout     = 60 * time.Second
	qdrantResponseCap = 4 << 20
	upsertBatchSize   = 64
)

type Store struct {
	baseURL    string
	apiKey     string
	collection string
	client     *http.Client
}

// Point is one indexed chunk. The text lives here rather than in console.db so
// retrieval never needs to open the Console database.
type Point struct {
	Route          string
	DocID          string
	DocName        string
	Section        string
	ChunkIndex     int
	Text           string
	EmbeddingModel string
	Vector         []float32
}

func NewStore(baseURL, apiKey, collection string) (*Store, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("vector database URL is invalid")
	}
	if strings.TrimSpace(collection) == "" {
		return nil, errors.New("a collection name is required")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery, parsed.Fragment = "", ""
	return &Store{
		baseURL: parsed.String(), apiKey: strings.TrimSpace(apiKey),
		collection: collection, client: localhttp.Client(qdrantTimeout),
	}, nil
}

func (s *Store) Ready(ctx context.Context) error {
	_, err := s.do(ctx, http.MethodGet, "/readyz", nil)
	return err
}

// EnsureCollection creates the collection when it is missing and recreates it
// when the stored vector size no longer matches the configured embedding model.
// Recreating is the honest response to a dimension change: vectors from two
// different models are not comparable, so the corpus is re-embedded rather than
// mixed.
func (s *Store) EnsureCollection(ctx context.Context, dimension int) error {
	if dimension <= 0 {
		return errors.New("the embedding dimension is unknown")
	}
	existing, err := s.collectionDimension(ctx)
	if err != nil {
		return err
	}
	if existing == dimension {
		return nil
	}
	if existing > 0 {
		if _, err := s.do(ctx, http.MethodDelete, "/collections/"+s.collection, nil); err != nil {
			return err
		}
	}
	body := map[string]any{
		"vectors": map[string]any{"size": dimension, "distance": "Cosine"},
	}
	if _, err := s.do(ctx, http.MethodPut, "/collections/"+s.collection, body); err != nil {
		return err
	}
	// The route split is a filtered search on every request, so the field is
	// indexed rather than scanned.
	_, err = s.do(ctx, http.MethodPut, "/collections/"+s.collection+"/index?wait=true", map[string]any{
		"field_name": "route", "field_schema": "keyword",
	})
	return err
}

func (s *Store) collectionDimension(ctx context.Context) (int, error) {
	payload, err := s.do(ctx, http.MethodGet, "/collections/"+s.collection, nil)
	if err != nil {
		if errors.Is(err, errNotFound) {
			return 0, nil
		}
		return 0, err
	}
	var decoded struct {
		Result struct {
			Config struct {
				Params struct {
					Vectors struct {
						Size int `json:"size"`
					} `json:"vectors"`
				} `json:"params"`
			} `json:"config"`
		} `json:"result"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return 0, errors.New("the vector database returned an unreadable collection")
	}
	return decoded.Result.Config.Params.Vectors.Size, nil
}

func (s *Store) Upsert(ctx context.Context, points []Point) error {
	for start := 0; start < len(points); start += upsertBatchSize {
		end := min(start+upsertBatchSize, len(points))
		rows := make([]map[string]any, 0, end-start)
		for _, point := range points[start:end] {
			id, err := pointID()
			if err != nil {
				return err
			}
			rows = append(rows, map[string]any{
				"id":     id,
				"vector": point.Vector,
				"payload": map[string]any{
					"route": point.Route, "doc_id": point.DocID, "doc_name": point.DocName,
					"section": point.Section, "chunk_index": point.ChunkIndex,
					"text": point.Text, "embedding_model": point.EmbeddingModel,
				},
			})
		}
		if _, err := s.do(ctx, http.MethodPut, "/collections/"+s.collection+"/points?wait=true",
			map[string]any{"points": rows}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) DeleteDocument(ctx context.Context, docID string) error {
	_, err := s.do(ctx, http.MethodPost, "/collections/"+s.collection+"/points/delete?wait=true", map[string]any{
		"filter": map[string]any{"must": []any{
			map[string]any{"key": "doc_id", "match": map[string]any{"value": docID}},
		}},
	})
	if errors.Is(err, errNotFound) {
		return nil
	}
	return err
}

// pointID is a random version-4 UUID. Qdrant accepts UUIDs or unsigned
// integers, and deletion is by payload filter, so an id never needs to be
// remembered.
func pointID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(raw)
	return fmt.Sprintf("%s-%s-%s-%s-%s", encoded[0:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:]), nil
}

var errNotFound = errors.New("not found")

func (s *Store) do(ctx context.Context, method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, s.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if s.apiKey != "" {
		request.Header.Set("api-key", s.apiKey)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return nil, errors.New("the vector database could not be reached")
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, qdrantResponseCap))
	if response.StatusCode == http.StatusNotFound {
		return nil, errNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("the vector database returned status %d", response.StatusCode)
	}
	if readErr != nil {
		return nil, errors.New("the vector database returned an unreadable response")
	}
	return payload, nil
}
