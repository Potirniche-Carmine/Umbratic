package state

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"umbratic-veil-console/internal/config"
)

// Document is one uploaded file in the company corpus. The extracted chunk text
// is not here: it lives in the Qdrant payload so retrieval never touches this
// database.
type Document struct {
	ID   string
	Name string
	Kind string
	// Routes is the set of teams this document is available to. Stored as one
	// canonically ordered comma-separated column.
	Routes     []string
	Status     string
	Error      string
	ChunkCount int
	ByteSize   int64
	SHA256     string
	UploadedAt time.Time
}

// HasRoute reports whether this document is available to a team, for the
// checkbox that says so.
func (d Document) HasRoute(route string) bool {
	for _, candidate := range d.Routes {
		if candidate == route {
			return true
		}
	}
	return false
}

const (
	DocumentPending    = "pending"
	DocumentProcessing = "processing"
	DocumentIndexed    = "indexed"
	DocumentFailed     = "failed"
)

// CorpusCaps bound the corpus so an upload cannot grow it without limit.
const (
	MaxDocuments = 1000
	MaxChunks    = 100_000
)

func (s *Store) InsertDocument(ctx context.Context, doc Document) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO documents(
id,name,kind,route,status,error,chunk_count,byte_size,sha256,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		doc.ID, doc.Name, doc.Kind, config.FormatRoutes(doc.Routes), DocumentPending, "", 0, doc.ByteSize, doc.SHA256, doc.UploadedAt.Unix())
	return err
}

func (s *Store) Documents(ctx context.Context) ([]Document, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,name,kind,route,status,error,chunk_count,byte_size,sha256,uploaded_at
FROM documents ORDER BY uploaded_at DESC, name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	documents := []Document{}
	for rows.Next() {
		var doc Document
		var uploaded int64
		var route string
		if err := rows.Scan(&doc.ID, &doc.Name, &doc.Kind, &route, &doc.Status, &doc.Error,
			&doc.ChunkCount, &doc.ByteSize, &doc.SHA256, &uploaded); err != nil {
			return nil, err
		}
		doc.Routes = config.ParseRoutes(route)
		doc.UploadedAt = time.Unix(uploaded, 0)
		documents = append(documents, doc)
	}
	return documents, rows.Err()
}

func (s *Store) Document(ctx context.Context, id string) (Document, bool, error) {
	var doc Document
	var uploaded int64
	var route string
	err := s.db.QueryRowContext(ctx, `SELECT id,name,kind,route,status,error,chunk_count,byte_size,sha256,uploaded_at
FROM documents WHERE id=?`, id).Scan(&doc.ID, &doc.Name, &doc.Kind, &route, &doc.Status, &doc.Error,
		&doc.ChunkCount, &doc.ByteSize, &doc.SHA256, &uploaded)
	if errors.Is(err, sql.ErrNoRows) {
		return Document{}, false, nil
	}
	if err != nil {
		return Document{}, false, err
	}
	doc.Routes = config.ParseRoutes(route)
	doc.UploadedAt = time.Unix(uploaded, 0)
	return doc, true, nil
}

// PendingDocument claims the oldest queued document for the ingestion worker.
// The status write is the claim, so two workers cannot pick up the same row.
func (s *Store) PendingDocument(ctx context.Context) (Document, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Document{}, false, err
	}
	defer tx.Rollback()
	var doc Document
	var uploaded int64
	var route string
	err = tx.QueryRowContext(ctx, `SELECT id,name,kind,route,status,error,chunk_count,byte_size,sha256,uploaded_at
FROM documents WHERE status=? ORDER BY uploaded_at ASC LIMIT 1`, DocumentPending).Scan(
		&doc.ID, &doc.Name, &doc.Kind, &route, &doc.Status, &doc.Error,
		&doc.ChunkCount, &doc.ByteSize, &doc.SHA256, &uploaded)
	if errors.Is(err, sql.ErrNoRows) {
		return Document{}, false, nil
	}
	if err != nil {
		return Document{}, false, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE documents SET status=?, error='' WHERE id=?", DocumentProcessing, doc.ID); err != nil {
		return Document{}, false, err
	}
	doc.Routes = config.ParseRoutes(route)
	doc.Status, doc.UploadedAt = DocumentProcessing, time.Unix(uploaded, 0)
	return doc, true, tx.Commit()
}

func (s *Store) MarkDocumentIndexed(ctx context.Context, id string, chunkCount int) error {
	_, err := s.db.ExecContext(ctx, "UPDATE documents SET status=?, error='', chunk_count=? WHERE id=?",
		DocumentIndexed, chunkCount, id)
	return err
}

func (s *Store) MarkDocumentFailed(ctx context.Context, id, reason string) error {
	if len([]rune(reason)) > 300 {
		reason = string([]rune(reason)[:300])
	}
	_, err := s.db.ExecContext(ctx, "UPDATE documents SET status=?, error=?, chunk_count=0 WHERE id=?",
		DocumentFailed, reason, id)
	return err
}

// QueueDocument returns a document to the ingestion queue, which is what both
// re-index and retag need: the chunks are rebuilt rather than edited in place.
func (s *Store) QueueDocument(ctx context.Context, id string, routes []string) error {
	route := config.FormatRoutes(routes)
	if route == "" {
		_, err := s.db.ExecContext(ctx, "UPDATE documents SET status=?, error='', chunk_count=0 WHERE id=?",
			DocumentPending, id)
		return err
	}

	_, err := s.db.ExecContext(ctx, "UPDATE documents SET status=?, error='', chunk_count=0, route=? WHERE id=?",
		DocumentPending, route, id)
	return err
}

// QueueAllDocuments re-queues the whole corpus, which is how an embedding-model
// change is applied: every document is re-embedded from its stored original.
func (s *Store) QueueAllDocuments(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, "UPDATE documents SET status=?, error='', chunk_count=0", DocumentPending)
	return err
}

func (s *Store) DeleteDocument(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM documents WHERE id=?", id)
	return err
}

// CorpusTotals reports the counts the Documents header shows against the caps.
func (s *Store) CorpusTotals(ctx context.Context) (documents int, chunks int, err error) {
	err = s.db.QueryRowContext(ctx, "SELECT COUNT(*), COALESCE(SUM(chunk_count),0) FROM documents").Scan(&documents, &chunks)
	return documents, chunks, err
}

func (s *Store) RAGSettings(ctx context.Context) (config.RAG, error) {
	settings := config.DefaultRAG()
	var enabled int
	var timeoutNS int64
	err := s.db.QueryRowContext(ctx, `SELECT enabled,embedding_base_url,embedding_model,dimension,
vector_base_url,collection,top_k,max_injected_bytes,timeout_ns FROM rag_settings WHERE id=1`).Scan(
		&enabled, &settings.EmbeddingBaseURL, &settings.EmbeddingModel, &settings.Dimension,
		&settings.VectorBaseURL, &settings.Collection, &settings.TopK, &settings.MaxInjectedBytes, &timeoutNS)
	if errors.Is(err, sql.ErrNoRows) {
		return config.DefaultRAG(), nil
	}
	if err != nil {
		return config.RAG{}, err
	}
	settings.Enabled = enabled != 0
	settings.Timeout = time.Duration(timeoutNS)
	return settings, nil
}

func (s *Store) SaveRAGSettings(ctx context.Context, settings config.RAG) error {
	enabled := 0
	if settings.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO rag_settings(
id,enabled,embedding_base_url,embedding_model,dimension,vector_base_url,collection,top_k,max_injected_bytes,timeout_ns)
VALUES(1,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, embedding_base_url=excluded.embedding_base_url,
embedding_model=excluded.embedding_model, dimension=excluded.dimension, vector_base_url=excluded.vector_base_url,
collection=excluded.collection, top_k=excluded.top_k, max_injected_bytes=excluded.max_injected_bytes,
timeout_ns=excluded.timeout_ns`,
		enabled, settings.EmbeddingBaseURL, settings.EmbeddingModel, settings.Dimension,
		settings.VectorBaseURL, settings.Collection, settings.TopK, settings.MaxInjectedBytes, int64(settings.Timeout))
	return err
}
