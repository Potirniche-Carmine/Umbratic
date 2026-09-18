package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"umbratic-veil-console/internal/config"
)

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
	request.Form = url.Values{"embedding_model": {"test-model-Embedding"}, "rag_enabled": {"on"}}
	settings, err := server.parseRAGSettings(request, config.DefaultRAG())
	if err != nil || settings.EmbeddingBaseURL != "http://127.0.0.1:8009/v1" || settings.EmbeddingModel != "test-model-Embedding" {
		t.Fatalf("settings: %+v %v", settings, err)
	}
	if !strings.Contains(models[0].Command, "--runner pooling") {
		t.Fatal("embedding runtime needs pooling")
	}
}
