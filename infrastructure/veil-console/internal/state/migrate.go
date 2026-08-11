package state

import (
	"database/sql"
	"fmt"
	"strings"
)

// Migrations are forward-only and never drop an administrator's data. The
// previous mechanism inspected the `configurations` shape and answered any
// surprise with `DROP TABLE`, which discarded the saved runtime configuration
// on an upgrade. Each step below is idempotent, runs inside one transaction,
// and is recorded by name in `applied_migrations`, so an interrupted upgrade
// resumes at the step that did not finish rather than at the beginning.
//
// The ledger records names rather than a counter. A name says exactly which
// steps a database has been through, and a name this build does not recognize
// is an unambiguous signal that a newer Console wrote the file — something a
// number can only imply.
type migration struct {
	name  string
	apply func(*sql.Tx) error
}

var migrations = []migration{
	{name: "base", apply: applyBaseSchema},
	{name: "configurations_generation_profile", apply: upgradeLegacyConfigurations},
	{name: "rag_corpus", apply: applyCorpusSchema},
	{name: "managed_models", apply: applyManagedModelSchema},
}

// Connection pragmas. These are per-connection settings rather than schema, and
// `journal_mode` cannot run inside a transaction, so they stay out of the steps.
const pragmas = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
`

const baseSchema = `
CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL UNIQUE,
  password_verifier TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS setup (
  id INTEGER PRIMARY KEY CHECK (id = 1), token_hash BLOB NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash BLOB PRIMARY KEY, username TEXT NOT NULL, csrf_hash BLOB NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS configurations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL,
  provider_base_url TEXT NOT NULL, model TEXT NOT NULL,
  context_length INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL,
  temperature REAL NOT NULL, top_p REAL NOT NULL,
  reasoning_effort TEXT NOT NULL, thinking_token_budget INTEGER,
  parallel_tool_calls INTEGER NOT NULL,
  max_concurrent_requests INTEGER NOT NULL,
  max_concurrent_requests_per_user INTEGER NOT NULL,
  queue_timeout_ns INTEGER NOT NULL,
  model_timeout_ns INTEGER NOT NULL, request_timeout_ns INTEGER NOT NULL,
  max_body_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
  CHECK (status IN ('pending','current','previous'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_configuration ON configurations(status) WHERE status = 'current';
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_configuration ON configurations(status) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL,
  event TEXT NOT NULL, outcome TEXT NOT NULL
);
`

// The corpus tables behind the Documents tab. Chunk text is never stored here —
// it lives in the Qdrant payload, so Veil reads the corpus without ever opening
// console.db.
const corpusSchema = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  route TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL,
  chunk_count INTEGER NOT NULL, byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, uploaded_at INTEGER NOT NULL,
  CHECK (route IN ('engineering','sales','marketing','all')),
  CHECK (status IN ('pending','processing','indexed','failed'))
);
CREATE INDEX IF NOT EXISTS documents_route ON documents(route);
CREATE TABLE IF NOT EXISTS rag_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL,
  embedding_base_url TEXT NOT NULL, embedding_model TEXT NOT NULL,
  dimension INTEGER NOT NULL, vector_base_url TEXT NOT NULL,
  collection TEXT NOT NULL, top_k INTEGER NOT NULL,
  max_injected_bytes INTEGER NOT NULL, timeout_ns INTEGER NOT NULL
);
`

// The models Console launches and supervises. `command` is the argument list
// vLLM is started with and the single source of truth: the port Veil reaches
// the model on and the window it publishes are read back out of it rather than
// stored a second time and allowed to drift.
const managedModelSchema = `
CREATE TABLE IF NOT EXISTS managed_models (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, command TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

func migrate(db *sql.DB) error {
	if _, err := db.Exec(pragmas); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS applied_migrations (
  name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
)`); err != nil {
		return err
	}
	applied, err := appliedMigrations(db)
	if err != nil {
		return err
	}
	known := make(map[string]bool, len(migrations))
	for _, step := range migrations {
		known[step.name] = true
	}
	for name := range applied {
		if !known[name] {
			return fmt.Errorf("console.db was written by a newer Veil Console (unknown migration %q)", name)
		}
	}
	for _, step := range migrations {
		if applied[step.name] {
			continue
		}
		if err := applyMigration(db, step); err != nil {
			return fmt.Errorf("apply migration %q: %w", step.name, err)
		}
	}
	return nil
}

func appliedMigrations(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query("SELECT name FROM applied_migrations")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	applied := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		applied[name] = true
	}
	return applied, rows.Err()
}

func applyMigration(db *sql.DB, step migration) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := step.apply(tx); err != nil {
		return err
	}
	if _, err := tx.Exec(
		"INSERT INTO applied_migrations(name, applied_at) VALUES(?, unixepoch())", step.name); err != nil {
		return err
	}
	return tx.Commit()
}

func applyBaseSchema(tx *sql.Tx) error {
	_, err := tx.Exec(baseSchema)
	return err
}

func applyCorpusSchema(tx *sql.Tx) error {
	_, err := tx.Exec(corpusSchema)
	return err
}

func applyManagedModelSchema(tx *sql.Tx) error {
	_, err := tx.Exec(managedModelSchema)
	return err
}

// configurationColumns is the current shape of the row Console reads back.
// Anything a legacy database is missing is filled from these defaults rather
// than discarded with the table around it.
var configurationColumns = []struct {
	name         string
	legacyFiller string
}{
	{name: "status", legacyFiller: "'current'"},
	{name: "provider_base_url", legacyFiller: "''"},
	{name: "model", legacyFiller: "''"},
	{name: "context_length", legacyFiller: "0"},
	{name: "max_output_tokens", legacyFiller: "8192"},
	{name: "temperature", legacyFiller: "0.2"},
	{name: "top_p", legacyFiller: "0.95"},
	{name: "reasoning_effort", legacyFiller: "'none'"},
	{name: "thinking_token_budget", legacyFiller: "NULL"},
	{name: "parallel_tool_calls", legacyFiller: "1"},
	{name: "max_concurrent_requests", legacyFiller: "32"},
	{name: "max_concurrent_requests_per_user", legacyFiller: "4"},
	{name: "queue_timeout_ns", legacyFiller: "30000000000"},
	{name: "model_timeout_ns", legacyFiller: "60000000000"},
	{name: "request_timeout_ns", legacyFiller: "75000000000"},
	{name: "max_body_bytes", legacyFiller: "67108864"},
	{name: "created_at", legacyFiller: "unixepoch()"},
}

// upgradeLegacyConfigurations rewrites a pre-generation-profile
// `configurations` table into the current shape, carrying every column the old
// table still has and defaulting only the ones it never had.
func upgradeLegacyConfigurations(tx *sql.Tx) error {
	existing, err := tableColumns(tx, "configurations")
	if err != nil {
		return err
	}
	if len(existing) == 0 || existing["temperature"] {
		return nil
	}
	names := make([]string, 0, len(configurationColumns))
	values := make([]string, 0, len(configurationColumns))
	for _, column := range configurationColumns {
		names = append(names, column.name)
		if existing[column.name] {
			values = append(values, column.name)
			continue
		}
		values = append(values, column.legacyFiller)
	}
	if _, err := tx.Exec(`ALTER TABLE configurations RENAME TO configurations_legacy`); err != nil {
		return err
	}
	// Indexes follow a renamed table, so they are dropped before the new table
	// recreates them under the same names.
	for _, index := range []string{"one_current_configuration", "one_pending_configuration"} {
		if _, err := tx.Exec("DROP INDEX IF EXISTS " + index); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(baseSchema); err != nil {
		return err
	}
	insert := fmt.Sprintf("INSERT INTO configurations(%s) SELECT %s FROM configurations_legacy",
		strings.Join(names, ","), strings.Join(values, ","))
	if _, err := tx.Exec(insert); err != nil {
		return err
	}
	_, err = tx.Exec(`DROP TABLE configurations_legacy`)
	return err
}

func tableColumns(tx *sql.Tx, table string) (map[string]bool, error) {
	rows, err := tx.Query("SELECT name FROM pragma_table_info(?)", table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}
