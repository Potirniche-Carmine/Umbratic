package rag

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/extract"
	"umbratic-veil-console/internal/state"
)

// Corpus is the Documents tab's engine. Uploads are stored, queued, and indexed
// by one worker goroutine, so a large PDF cannot starve the admin UI and two
// uploads cannot fight over the same collection.
type Corpus struct {
	store     *state.Store
	dir       string
	pdfBinary string

	mu       sync.RWMutex
	settings config.RAG
	apiKey   string

	signal chan struct{}
}

func NewCorpus(store *state.Store, dir, pdfBinary string, settings config.RAG, apiKey string) (*Corpus, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create document store: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}
	return &Corpus{
		store: store, dir: dir, pdfBinary: pdfBinary,
		settings: settings, apiKey: apiKey, signal: make(chan struct{}, 1),
	}, nil
}

func (c *Corpus) Settings() config.RAG {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.settings
}

func (c *Corpus) SetSettings(settings config.RAG) {
	c.mu.Lock()
	c.settings = settings
	c.mu.Unlock()
	c.Notify()
}

// Configured reports whether indexing can run at all. Uploads are accepted
// before the embedding runtime is configured; they simply stay queued.
func (c *Corpus) Configured() bool {
	settings := c.Settings()
	return strings.TrimSpace(settings.EmbeddingModel) != "" && settings.Dimension > 0
}

// VectorAPIKey is the installer-generated Qdrant key. It stays in memory, is
// never rendered into a page or an audit row, and is handed on only to the Veil
// child environment.
func (c *Corpus) VectorAPIKey() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.apiKey
}

func (c *Corpus) Notify() {
	select {
	case c.signal <- struct{}{}:
	default:
	}
}

// Save stores an upload and queues it. The type comes from the bytes, never
// from the name the browser sent.
func (c *Corpus) Save(ctx context.Context, name, route string, data []byte, now time.Time) (state.Document, error) {
	if !config.ValidRoute(route) {
		return state.Document{}, errors.New("route is invalid")
	}
	name = documentName(name)
	if name == "" {
		return state.Document{}, errors.New("file name is required")
	}
	kind, err := extract.Kind(data, name)
	if err != nil {
		return state.Document{}, err
	}
	documents, chunks, err := c.store.CorpusTotals(ctx)
	if err != nil {
		return state.Document{}, err
	}
	if documents >= state.MaxDocuments {
		return state.Document{}, fmt.Errorf("the corpus already holds %d documents", state.MaxDocuments)
	}
	if chunks >= state.MaxChunks {
		return state.Document{}, fmt.Errorf("the corpus already holds %d chunks", state.MaxChunks)
	}
	digest := sha256.Sum256(data)
	id, err := pointID()
	if err != nil {
		return state.Document{}, err
	}
	document := state.Document{
		ID: id, Name: name, Kind: kind, Route: route, Status: state.DocumentPending,
		ByteSize: int64(len(data)), SHA256: hex.EncodeToString(digest[:]), UploadedAt: now,
	}
	if err := os.WriteFile(c.originalPath(id), data, 0o600); err != nil {
		return state.Document{}, errors.New("the document could not be stored")
	}
	if err := c.store.InsertDocument(ctx, document); err != nil {
		_ = os.Remove(c.originalPath(id))
		return state.Document{}, err
	}
	c.Notify()
	return document, nil
}

// Delete removes the chunks, the stored original, and the row, in that order:
// a failure part-way leaves a visible row rather than orphaned vectors.
func (c *Corpus) Delete(ctx context.Context, id string) error {
	if store, err := c.vectorStore(); err == nil {
		if err := store.DeleteDocument(ctx, id); err != nil {
			return err
		}
	}
	if err := os.Remove(c.originalPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("the stored document could not be removed")
	}
	return c.store.DeleteDocument(ctx, id)
}

// Requeue rebuilds a document's chunks, optionally under a new route. Retagging
// is a re-index because the route lives in every chunk's payload.
func (c *Corpus) Requeue(ctx context.Context, id, route string) error {
	if err := c.store.QueueDocument(ctx, id, route); err != nil {
		return err
	}
	c.Notify()
	return nil
}

func (c *Corpus) RequeueAll(ctx context.Context) error {
	if err := c.store.QueueAllDocuments(ctx); err != nil {
		return err
	}
	c.Notify()
	return nil
}

// Probe tests a candidate embedding configuration and reports the vector
// dimension the collection would need.
func Probe(ctx context.Context, settings config.RAG) (int, error) {
	embedder, err := NewEmbedder(settings.EmbeddingBaseURL, settings.EmbeddingModel)
	if err != nil {
		return 0, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return embedder.Probe(probeCtx)
}

// Run drains the queue whenever there is work, and re-checks periodically so a
// document queued while the embedding runtime was down is retried once it is
// back.
func (c *Corpus) Run(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		if c.Configured() {
			c.drain(ctx)
		}
		select {
		case <-ctx.Done():
			return
		case <-c.signal:
		case <-ticker.C:
		}
	}
}

func (c *Corpus) drain(ctx context.Context) {
	for ctx.Err() == nil {
		document, ok, err := c.store.PendingDocument(ctx)
		if err != nil || !ok {
			return
		}
		if err := c.index(ctx, document); err != nil {
			_ = c.store.MarkDocumentFailed(ctx, document.ID, err.Error())
			continue
		}
	}
}

func (c *Corpus) index(ctx context.Context, document state.Document) error {
	settings := c.Settings()
	data, err := os.ReadFile(c.originalPath(document.ID))
	if err != nil {
		return errors.New("the stored document could not be read")
	}
	segments, err := extract.Segments(ctx, extract.Options{
		Kind: document.Kind, Data: data, Path: c.originalPath(document.ID), PDFBinary: c.pdfBinary,
	})
	if err != nil {
		return err
	}
	chunks := Chunks(segments)
	if len(chunks) == 0 {
		return errors.New("no readable text was found in this document")
	}
	_, existingChunks, err := c.store.CorpusTotals(ctx)
	if err != nil {
		return err
	}
	if existingChunks+len(chunks) > state.MaxChunks {
		return fmt.Errorf("indexing this document would exceed the %d chunk limit", state.MaxChunks)
	}

	embedder, err := NewEmbedder(settings.EmbeddingBaseURL, settings.EmbeddingModel)
	if err != nil {
		return err
	}
	inputs := make([]string, len(chunks))
	for index, chunk := range chunks {
		inputs[index] = chunk.Text
	}
	vectors, err := embedder.Embed(ctx, inputs)
	if err != nil {
		return err
	}
	for _, vector := range vectors {
		if len(vector) != settings.Dimension {
			return errors.New("the embedding runtime returned a different vector size than the corpus was built with")
		}
	}

	vectorStore, err := c.vectorStore()
	if err != nil {
		return err
	}
	if err := vectorStore.EnsureCollection(ctx, settings.Dimension); err != nil {
		return err
	}
	if err := vectorStore.DeleteDocument(ctx, document.ID); err != nil {
		return err
	}
	points := make([]Point, len(chunks))
	for index, chunk := range chunks {
		points[index] = Point{
			Route: document.Route, DocID: document.ID, DocName: document.Name,
			Section: chunk.Section, ChunkIndex: chunk.Index, Text: chunk.Text,
			EmbeddingModel: settings.EmbeddingModel, Vector: vectors[index],
		}
	}
	if err := vectorStore.Upsert(ctx, points); err != nil {
		return err
	}
	return c.store.MarkDocumentIndexed(ctx, document.ID, len(chunks))
}

func (c *Corpus) vectorStore() (*Store, error) {
	c.mu.RLock()
	settings, apiKey := c.settings, c.apiKey
	c.mu.RUnlock()
	return NewStore(settings.VectorBaseURL, apiKey, settings.Collection)
}

// EnsureCollection is the settings-save path: it proves the vector database is
// reachable and that the collection matches the configured dimension before an
// administrator is told the change was applied.
func (c *Corpus) EnsureCollection(ctx context.Context, dimension int) error {
	store, err := c.vectorStore()
	if err != nil {
		return err
	}
	return store.EnsureCollection(ctx, dimension)
}

func (c *Corpus) originalPath(id string) string {
	return filepath.Join(c.dir, id)
}

// documentName keeps the administrator's file name for display and citations
// while removing anything that could steer a path or a prompt line.
func documentName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "." || name == ".." {
		return ""
	}
	if len(name) > 200 {
		name = name[:200]
	}
	return name
}
