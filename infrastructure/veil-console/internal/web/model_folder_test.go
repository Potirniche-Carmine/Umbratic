package web

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"umbratic-veil-console/internal/modelfolder"
)

func writeModelFile(t *testing.T, root, name, data string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestLocalHuggingFaceCacheUsesMainAndBlobLinks(t *testing.T) {
	root := tempStateDir(t)
	repo := filepath.Join(root, "models--Qwen--model")
	writeModelFile(t, repo, "blobs/config", `{"model_type":"qwen"}`)
	writeModelFile(t, repo, "snapshots/first/config.json", `{}`)
	writeModelFile(t, repo, "snapshots/current/model.safetensors", "weights")
	if err := os.Symlink("../../blobs/config", filepath.Join(repo, "snapshots/current/config.json")); err != nil {
		t.Fatal(err)
	}
	writeModelFile(t, repo, "refs/main", "current\n")
	got, err := resolveLocalModel(root, "models--Qwen--model")
	if err != nil || got != filepath.Join(repo, "snapshots/current") {
		t.Fatalf("resolved %s: %v", got, err)
	}
	data, err := os.ReadFile(filepath.Join(got, "config.json"))
	if err != nil || string(data) != `{"model_type":"qwen"}` {
		t.Fatal("snapshot link not readable")
	}
	folders, _, err := localModelFolders(root)
	if err != nil || len(folders) != 1 || folders[0] != "models--Qwen--model" {
		t.Fatalf("cache missing from model list: %v %v", folders, err)
	}
}
func TestModelFolderRefSelectionDoesNotGuessOrTraverse(t *testing.T) {
	root := t.TempDir()
	writeModelFile(t, root, "snapshots/first/config.json", "{}")
	if _, err := modelfolder.Folder(root); err != nil {
		t.Fatal(err)
	}
	writeModelFile(t, root, "snapshots/second/config.json", "{}")
	if _, err := modelfolder.Folder(root); err == nil {
		t.Fatal("ambiguous snapshots accepted")
	}
	for _, ref := range []string{"missing", "../..", "/tmp", ""} {
		writeModelFile(t, root, "refs/main", ref)
		if _, err := modelfolder.Folder(root); err == nil {
			t.Fatalf("invalid main %q accepted", ref)
		}
	}
}
func TestCreateCachedModelUsesSnapshotPathAndRepositoryName(t *testing.T) {
	server, handler, cookies, csrf, cleanup := signedInConsole(t)
	defer cleanup()
	writeModelFile(t, server.modelsDirectory(), "Qwen/snapshots/current/config.json", "{}")
	response := authorizedPost(t, handler, cookies, "/models/create", url.Values{"csrf": {csrf}, "folder": {"Qwen"}, "kind": {"chat"}, "port": {"8009"}})
	if response.Code != http.StatusSeeOther {
		t.Fatalf("create: %d %s", response.Code, response.Body.String())
	}
	models, err := server.store.ManagedModels(t.Context())
	if err != nil || len(models) != 1 {
		t.Fatalf("models: %v %v", models, err)
	}
	facts, err := models[0].Parse()
	if err != nil || facts.ModelPath != filepath.Join(server.modelsDirectory(), "Qwen/snapshots/current") || models[0].ID != "Qwen" {
		t.Fatalf("wrong cached model: %+v %v", models[0], err)
	}
}

// Optional read-only check against an already downloaded cache; never copies
// weights, modifies the cache, or starts a runtime.
func TestExistingModelCache(t *testing.T) {
	root := os.Getenv("UMBRATIC_TEST_MODEL_CACHE")
	if root == "" {
		t.Skip("set UMBRATIC_TEST_MODEL_CACHE to inspect an existing download")
	}
	selected, err := modelfolder.Folder(root)
	if err != nil {
		t.Fatal(err)
	}
	if !modelfolder.ConfigExists(selected) {
		t.Fatal("download has no readable model config")
	}
}
