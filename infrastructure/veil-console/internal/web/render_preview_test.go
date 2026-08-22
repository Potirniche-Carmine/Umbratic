package web

import (
	"encoding/json"
	"html/template"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/state"
	"umbratic-veil-console/internal/supervisor"
)

// Renders each page to VEIL_PREVIEW_DIR for visual review. Skipped unless that
// is set, so it costs nothing in a normal run.
func TestRenderPreviewPages(t *testing.T) {
	dir := os.Getenv("VEIL_PREVIEW_DIR")
	if dir == "" {
		t.Skip("set VEIL_PREVIEW_DIR to render preview pages")
	}
	server, closeServer := testServer(t)
	defer closeServer()

	catalogJSON, _ := json.Marshal(config.ServingCatalog)
	uploaded := time.Date(2026, 8, 20, 14, 5, 0, 0, time.UTC)
	settings := config.DefaultRAG()

	docsBase := func(all []state.Document, total int) pageData {
		return pageData{
			Title: "Documents", CSRF: "preview", Username: "owner", RAG: settings,
			EmbeddingChoices:  config.EmbeddingChoices,
			RouteChoices:      routeChoices(),
			DefaultRoute:      config.RouteAll,
			DefaultRouteLabel: routeLabels[config.RouteAll],
			Corpus: documentsView{
				All: all, Documents: total, Chunks: 412,
				MaxDocs: state.MaxDocuments, MaxChunks: state.MaxChunks, Dimension: 1024,
			},
		}
	}
	filled := docsBase([]state.Document{
		{ID: "a", Name: "Incident Runbook.pdf", Kind: "pdf", Status: "indexed", ChunkCount: 184, Route: "engineering", UploadedAt: uploaded},
		{ID: "b", Name: "Platform Architecture.docx", Kind: "docx", Status: "processing", ChunkCount: 0, Route: "engineering", UploadedAt: uploaded},
		{ID: "c", Name: "Employee Handbook.md", Kind: "md", Status: "indexed", ChunkCount: 228, Route: "all", UploadedAt: uploaded},
		{ID: "d", Name: "Q3 Pricing.xlsx", Kind: "xlsx", Status: "failed", ChunkCount: 0, Route: "sales", UploadedAt: uploaded},
	}, 4)
	empty := docsBase(nil, 0)

	models := pageData{
		Title: "Models", CSRF: "preview", Username: "owner",
		Models: modelsView{
			Configured: false, Registered: 2, Running: 1,
			Catalog: config.ServingCatalog, CatalogJSON: template.JS(catalogJSON),
			SuggestedPort: 8001, CustomKey: CustomCatalogKey,
			Form: modelForm{
				CatalogKey: config.ServingCatalog[0].Key,
				Variant:    config.ServingCatalog[0].Variants[0].Key,
				Command:    config.CatalogCommand(config.ServingCatalog[0], config.ServingCatalog[0].Variants[0], 8001),
			},
			Rows: []modelRow{
				{
					ManagedModel: config.ManagedModel{
						ID: "qwen3.8-27b", DisplayName: "Qwen3.8 27B", Role: config.RoleChat,
						Command: config.CatalogCommand(config.ServingCatalog[1], config.ServingCatalog[1].Variants[0], 8001),
					},
					State: supervisor.ModelHealthy, StateText: "Serving", Running: true, IsDefault: true,
					Summary: "Qwen/Qwen3.8-27B-FP8 · 8-bit (FP8) · 256K context · port 8001",
				},
				{
					ManagedModel: config.ManagedModel{
						ID: "ornith-1.5-35b-a3b", DisplayName: "Ornith 1.5 35B A3B", Role: config.RoleChat,
						Command: config.CatalogCommand(config.ServingCatalog[0], config.ServingCatalog[0].Variants[0], 8002),
					},
					State: supervisor.ModelStopped, StateText: "Stopped",
					Summary: "ornith-ai/Ornith-1.5-35B-A3B-NVFP4 · 4-bit (NVFP4) · 256K context · port 8002",
				},
			},
		},
	}
	modelsEmpty := models
	modelsEmpty.Models.Rows = nil
	modelsEmpty.Models.Registered = 0

	settingsPage := pageData{
		Title: "Settings", CSRF: "preview", Username: "owner",
		Config:           config.DefaultVeil(),
		DefaultModelName: "Qwen3.8 27B",
		ContextIndex:     3, ContextLabel: "64K tokens",
		Models: modelsView{Registered: 2},
	}
	settingsPage.Config.Model = "qwen3.8-27b"
	settingsPage.Config.ContextLength = 65536

	dashboard := pageData{
		Title: "Veil Console", CSRF: "preview", Username: "owner",
		Configured: true, Running: false, Status: supervisor.Status{}.String(),
		VeilURL: "http://127.0.0.1:8080",
		Models:  modelsView{Registered: 2, Running: 1},
	}

	dashboardRunning := dashboard
	dashboardRunning.Running = true
	dashboardRunning.Healthy = true
	dashboardRunning.Status = supervisor.Status{Running: true, Healthy: true, PID: 4821}.String()

	errored := filled
	errored.Error = "The embedding runtime at http://127.0.0.1:8001/v1 did not answer."

	pages := []struct {
		file, tmpl string
		data       pageData
	}{
		{"documents.html", "documents.html", filled},
		{"documents-empty.html", "documents.html", empty},
		{"documents-error.html", "documents.html", errored},
		{"models.html", "models.html", models},
		{"models-empty.html", "models.html", modelsEmpty},
		{"settings.html", "settings.html", settingsPage},
		{"dashboard.html", "dashboard.html", dashboard},
		{"dashboard-running.html", "dashboard.html", dashboardRunning},
	}
	for _, page := range pages {
		response := httptest.NewRecorder()
		server.render(response, page.tmpl, page.data)
		if err := os.WriteFile(filepath.Join(dir, page.file), response.Body.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
