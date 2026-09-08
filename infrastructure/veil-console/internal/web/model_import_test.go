package web

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"umbratic-veil-console/internal/config"
)

func modelUpload(t *testing.T, names ...string) (*bytes.Buffer, string) {
	t.Helper()
	body := new(bytes.Buffer)
	writer := multipart.NewWriter(body)
	for _, name := range names {
		part, err := writer.CreateFormFile(name, filepath.Base(name))
		if err != nil {
			t.Fatal(err)
		}
		part.Write([]byte(`{"model_type":"test"}`))
	}
	writer.Close()
	return body, writer.Boundary()
}

func TestImportModelFolderIsAtomicAndDoesNotOverwrite(t *testing.T) {
	directory := t.TempDir()
	for _, file := range []string{"model.safetensors", "model.bin", "model.gguf", "weights.fp8", "weights.nvfp4"} {
		name := strings.ReplaceAll(file, ".", "-")
		body, boundary := modelUpload(t, name+"/config.json", name+"/"+file, name+"/tokenizer/tokenizer.json")
		if got, err := importModelFolder(multipart.NewReader(body, boundary), directory); err != nil || got != name {
			t.Fatalf("import: %q %v", got, err)
		}
		body, boundary = modelUpload(t, name+"/config.json")
		if _, err := importModelFolder(multipart.NewReader(body, boundary), directory); err == nil {
			t.Fatal("existing folder overwritten")
		}
	}
	for _, names := range [][]string{{"../escape/config.json"}, {"model/../config.json"}, {"bad/config.json", "bad/config.json"}, {"incomplete/weights.bin"}, {"one/config.json", "two/config.json"}} {
		body, boundary := modelUpload(t, names...)
		if _, err := importModelFolder(multipart.NewReader(body, boundary), directory); err == nil {
			t.Fatalf("accepted %v", names)
		}
	}
	entries, _ := os.ReadDir(directory)
	if len(entries) != 5 {
		t.Fatalf("failed imports left files behind: %v", entries)
	}
}

func TestImportRequiresSessionAndCSRFBeforeReadingFiles(t *testing.T) {
	server, handler, cookies, csrf, cleanup := signedInConsole(t)
	defer cleanup()
	for _, token := range []string{"", "wrong", csrf} {
		body, boundary := modelUpload(t, "uploaded/config.json", "uploaded/model.safetensors")
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8177/models/import", body)
		request.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
		request.Header.Set("X-CSRF-Token", token)
		for _, cookie := range cookies {
			request.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if token != csrf && response.Code != http.StatusForbidden {
			t.Fatalf("invalid CSRF accepted: %d", response.Code)
		}
		if token == csrf && response.Code != http.StatusOK {
			t.Fatalf("valid import failed: %d %s", response.Code, response.Body.String())
		}
	}
	if _, err := resolveLocalModel(server.modelsDirectory(), "uploaded"); err != nil {
		t.Fatal(err)
	}
}

func TestLocalModelNamesAndTraversal(t *testing.T) {
	if got := localModelID(".. My Model BF16"); got != "My-Model-BF16" {
		t.Fatal(got)
	}
	for _, name := range []string{"", "..", "../model", `..\model`, "/tmp/model"} {
		if _, err := resolveLocalModel(t.TempDir(), name); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
}

func TestEmbeddingModelUsesLocalRegistryAndIsNotAChatChoice(t *testing.T) {
	server, handler, cookies, csrf, cleanup := signedInConsole(t)
	defer cleanup()
	form := url.Values{"csrf": {csrf}, "folder": {"test-model"}, "kind": {"embedding"}, "port": {"8009"}}
	response := authorizedPost(t, handler, cookies, "/models/create", form)
	if response.Code != http.StatusSeeOther {
		t.Fatalf("create: %d %s", response.Code, response.Body.String())
	}
	models, err := server.store.ManagedModels(t.Context())
	if err != nil || len(models) != 1 || models[0].Role != config.RoleEmbedding {
		t.Fatalf("models: %+v %v", models, err)
	}
	env, err := config.ModelsEnvJSON(models)
	if err != nil || env != "" {
		t.Fatalf("embedding model published as chat: %q %v", env, err)
	}
	request := httptest.NewRequest(http.MethodPost, "/documents/settings", nil)
	request.Form = url.Values{"embedding_model": {"test-model"}, "rag_enabled": {"on"}}
	settings, err := server.parseRAGSettings(request, config.DefaultRAG())
	if err != nil || settings.EmbeddingBaseURL != "http://127.0.0.1:8009/v1" || settings.EmbeddingModel != "test-model" {
		t.Fatalf("settings: %+v %v", settings, err)
	}
	if !strings.Contains(models[0].Command, "--runner pooling") {
		t.Fatal("embedding runtime needs pooling")
	}
}
