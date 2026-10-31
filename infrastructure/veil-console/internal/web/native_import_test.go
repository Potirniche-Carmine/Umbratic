package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestModelsOpenFolderWithoutUpload(t *testing.T) {
	_, handler, cookies, _, cleanup := signedInConsole(t)
	defer cleanup()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, formRequest(http.MethodGet, "/models", nil, cookies...))
	body := response.Body.String()
	if !strings.Contains(body, `href="umbratic-models:open"`) {
		t.Fatal("models folder link missing")
	}
	for _, removed := range []string{"webkitdirectory", "data-model-files", "data-model-import", "Drop a model folder"} {
		if strings.Contains(body, removed) {
			t.Fatalf("browser upload remains: %s", removed)
		}
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, formRequest(http.MethodPost, "/models/import", nil, cookies...))
	if response.Code == http.StatusOK {
		t.Fatal("removed upload endpoint accepted request")
	}
}

func TestModelsRefreshDetectsCopiedFoldersAndShowsIncompleteCache(t *testing.T) {
	server, handler, cookies, _, cleanup := signedInConsole(t)
	defer cleanup()
	server.startup.ModelsDir = t.TempDir()
	page := func() string {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, formRequest(http.MethodGet, "/models", nil, cookies...))
		if response.Code != http.StatusOK {
			t.Fatalf("models: %d", response.Code)
		}
		return response.Body.String()
	}
	if !strings.Contains(page(), "No model folders yet.") {
		t.Fatal("missing empty state")
	}
	writeModelFile(t, server.modelsDirectory(), "Qwen/config.json", "{}")
	writeModelFile(t, server.modelsDirectory(), "Incomplete/refs/main", "missing")
	writeModelFile(t, server.modelsDirectory(), "Incomplete/snapshots/other/config.json", "{}")
	body := page()
	for _, want := range []string{"1 model", "<strong>Qwen</strong>", "<strong>Incomplete</strong>", "The main snapshot is incomplete"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing refreshed result: %s", want)
		}
	}
	if strings.Contains(body, `value="Incomplete"`) {
		t.Fatal("incomplete cache offered for registration")
	}
}
