package state

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"umbratic-veil-console/internal/config"
)

// The previous mechanism answered an unrecognized `configurations` shape with
// DROP TABLE, so an upgrade silently discarded the administrator's runtime
// configuration. The upgrade must now carry every column the old table had.
func TestLegacyConfigurationSurvivesUpgrade(t *testing.T) {
	dir := tempStateDir(t)
	dbPath := filepath.Join(dir, "console.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	legacy := `CREATE TABLE configurations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, protocol TEXT NOT NULL,
  provider_base_url TEXT NOT NULL, model TEXT NOT NULL, context_length INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL, model_timeout_ns INTEGER NOT NULL,
  request_timeout_ns INTEGER NOT NULL, max_body_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)`
	if _, err := db.Exec(legacy); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO configurations(status,protocol,provider_base_url,model,context_length,
max_output_tokens,model_timeout_ns,request_timeout_ns,max_body_bytes,created_at)
VALUES('current','openai','http://127.0.0.1:8000/v1','company-chat',65536,4096,60000000000,75000000000,67108864,1000)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	cfg, ok, err := store.Configuration(context.Background(), "current")
	if err != nil || !ok {
		t.Fatalf("configuration missing after upgrade: ok=%v err=%v", ok, err)
	}
	if cfg.Model != "company-chat" || cfg.ProviderBaseURL != "http://127.0.0.1:8000/v1" {
		t.Fatalf("upgrade lost administrator values: %+v", cfg)
	}
	if cfg.ContextLength != 65536 || cfg.MaxOutputTokens != 4096 {
		t.Fatalf("upgrade lost sizing values: %+v", cfg)
	}
	// Columns the legacy table never had come from the current defaults.
	if cfg.Temperature != 0.2 || cfg.MaxConcurrentRequests != 32 {
		t.Fatalf("upgrade did not default the new columns: %+v", cfg)
	}
}

// Reopening must not re-run a step, and the ledger must name every step that
// ran so an interrupted upgrade resumes where it stopped.
func TestMigrationsAreIdempotentAndRecordedByName(t *testing.T) {
	dir := tempStateDir(t)
	for range 3 {
		store, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "console.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query("SELECT name FROM applied_migrations ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	recorded := map[string]int{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		recorded[name]++
	}
	if len(recorded) != len(migrations) {
		t.Fatalf("ledger holds %d steps, want %d: %v", len(recorded), len(migrations), recorded)
	}
	for _, step := range migrations {
		if recorded[step.name] != 1 {
			t.Fatalf("step %q recorded %d times", step.name, recorded[step.name])
		}
	}
}

// A database written by a newer Console carries a step this build has never
// heard of. Refusing is the only safe answer: running our steps on top of an
// unknown schema is how data gets lost.
func TestUnknownMigrationIsRefused(t *testing.T) {
	dir := tempStateDir(t)
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "console.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		"INSERT INTO applied_migrations(name, applied_at) VALUES('from_the_future', 1)"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err == nil {
		reopened.Close()
		t.Fatal("a database from a newer Console was opened and migrated")
	}
}

func TestDocumentLifecycle(t *testing.T) {
	ctx := context.Background()
	store, err := Open(tempStateDir(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	doc := Document{ID: "doc-1", Name: "handbook.md", Kind: "md", Routes: []string{"sales"},
		ByteSize: 24, SHA256: "abc", UploadedAt: time.Unix(2000, 0)}
	if err := store.InsertDocument(ctx, doc); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := store.PendingDocument(ctx)
	if err != nil || !ok || claimed.ID != "doc-1" {
		t.Fatalf("pending document not claimed: %v %v %+v", err, ok, claimed)
	}
	if _, ok, _ := store.PendingDocument(ctx); ok {
		t.Fatal("a claimed document was handed out twice")
	}
	if err := store.MarkDocumentIndexed(ctx, "doc-1", 7); err != nil {
		t.Fatal(err)
	}
	documents, chunks, err := store.CorpusTotals(ctx)
	if err != nil || documents != 1 || chunks != 7 {
		t.Fatalf("totals wrong: %d %d %v", documents, chunks, err)
	}
	// A document can be available to more than one team, and the stored set is
	// canonically ordered so the same set is always the same string.
	if err := store.QueueDocument(ctx, "doc-1", []string{"marketing", "engineering"}); err != nil {
		t.Fatal(err)
	}
	stored, _, err := store.Document(ctx, "doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(stored.Routes, ",") != "engineering,marketing" {
		t.Fatalf("retag did not store the set: %+v", stored)
	}
	if stored.Status != DocumentPending || stored.ChunkCount != 0 {
		t.Fatalf("retag did not requeue: %+v", stored)
	}
	if !stored.HasRoute("engineering") || stored.HasRoute("sales") {
		t.Fatalf("HasRoute disagrees with the stored set: %+v", stored)
	}
	// An unknown route is dropped rather than stored, so a set of nothing but
	// unknowns leaves the document where it was.
	if err := store.QueueDocument(ctx, "doc-1", []string{"everyone"}); err != nil {
		t.Fatal(err)
	}
	stored, _, _ = store.Document(ctx, "doc-1")
	if strings.Join(stored.Routes, ",") != "engineering,marketing" {
		t.Fatalf("an unknown route changed the set: %+v", stored)
	}
}

func TestRAGSettingsRoundTrip(t *testing.T) {
	ctx := context.Background()
	store, err := Open(tempStateDir(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	defaults, err := store.RAGSettings(ctx)
	if err != nil || defaults.Collection != "company_docs_v1" {
		t.Fatalf("defaults wrong: %+v %v", defaults, err)
	}
	saved := config.DefaultRAG()
	saved.Enabled, saved.EmbeddingModel, saved.Dimension, saved.TopK = true, "qwen3-embedding-0.6b", 1024, 8
	if err := store.SaveRAGSettings(ctx, saved); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.RAGSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != saved {
		t.Fatalf("round trip changed settings: %+v want %+v", loaded, saved)
	}
}
