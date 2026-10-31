package state

import (
	"path/filepath"
	"testing"
	"time"

	"umbratic-veil-console/internal/config"
)

func TestModelNameMigrationPreservesRuntimeAndRetrieval(t *testing.T) {
	dir := tempStateDir(t)
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Reconstruct the prior schema with a differently named display field.
	if _, err := s.db.Exec(`ALTER TABLE managed_models ADD COLUMN display_name TEXT NOT NULL DEFAULT 'Old label'; DELETE FROM applied_migrations WHERE name='managed_model_single_name'`); err != nil {
		t.Fatal(err)
	}
	models := []config.ManagedModel{
		{ID: "Qwen27B", Command: config.DefaultCommand(filepath.Join(dir, "Qwen3.8-27B-MLX-4bit"), "Qwen27B", 8001)},
		{ID: "Qwen0.6B", Role: config.RoleSpeech, Command: config.DefaultCommand("/models/asr", "Qwen0.6B", 8002)},
		{ID: "Vectors", Role: config.RoleEmbedding, Command: config.DefaultCommand("/models/embedding", "Vectors", 8003)},
	}
	for _, model := range models {
		if err := s.InsertManagedModel(t.Context(), model); err != nil {
			t.Fatal(err)
		}
		if err := s.SetModelEnabled(t.Context(), model.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	rag := config.DefaultRAG()
	rag.EmbeddingModel = "Vectors"
	if err := s.SaveRAGSettings(t.Context(), rag); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, id := range []string{"Qwen27B", "Qwen0.6B-Dictation", "Vectors-Embedding"} {
		model, found, err := s.ManagedModel(t.Context(), id)
		if err != nil || !found || !model.Enabled {
			t.Fatalf("model lost: %+v %v", model, err)
		}
		if _, err := model.Parse(); err != nil {
			t.Fatal(err)
		}
		if id == "Qwen27B" && model.SamplingJSON == "" {
			t.Fatal("Qwen defaults missing")
		}
	}
	saved, err := s.RAGSettings(t.Context())
	if err != nil || saved.EmbeddingModel != "Vectors-Embedding" {
		t.Fatalf("retrieval reference lost: %+v %v", saved, err)
	}
	var columns int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('managed_models') WHERE name='display_name'`).Scan(&columns); err != nil || columns != 0 {
		t.Fatal("duplicate model name remains")
	}
}

func TestStatusPollingDoesNotExtendSession(t *testing.T) {
	s, err := Open(tempStateDir(t))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now()
	token, _, err := s.CreateSession(t.Context(), "owner", now)
	if err != nil {
		t.Fatal(err)
	}
	for minute := 1; minute < 10; minute++ {
		if _, err := s.Session(t.Context(), token, now.Add(time.Duration(minute)*time.Minute), false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Session(t.Context(), token, now.Add(10*time.Minute), false); err == nil {
		t.Fatal("polling kept an idle session alive")
	}
}
