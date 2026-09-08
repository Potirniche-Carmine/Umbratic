package web

import (
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

	chat := config.CatalogFor(config.KindChat)
	dictation := config.CatalogFor(config.KindDictation)
	uploaded := time.Date(2026, 8, 20, 14, 5, 0, 0, time.UTC)
	settings := config.DefaultRAG()

	docsBase := func(all []state.Document, total int) pageData {
		return pageData{
			Title: "Documents", CSRF: "preview", Username: "owner", RAG: settings,
			EmbeddingChoices: []config.EmbeddingChoice{{Model: "local-embedding", Label: "Local embedding model"}},
			RouteChoices:     routeChoices(),
			Corpus: documentsView{
				All: all, Documents: total, Chunks: 412,
				MaxDocs: state.MaxDocuments, MaxChunks: state.MaxChunks, Dimension: 1024,
			},
		}
	}
	filled := docsBase([]state.Document{
		{ID: "a", Name: "Incident Runbook.pdf", Kind: "pdf", Status: "indexed", ChunkCount: 184, Routes: []string{"engineering"}, UploadedAt: uploaded},
		{ID: "b", Name: "Platform Architecture.docx", Kind: "docx", Status: "processing", ChunkCount: 0, Routes: []string{"engineering"}, UploadedAt: uploaded},
		{ID: "c", Name: "Employee Handbook.md", Kind: "md", Status: "indexed", ChunkCount: 228, Routes: []string{"engineering", "sales", "marketing"}, UploadedAt: uploaded},
		{ID: "d", Name: "Q3 Pricing.xlsx", Kind: "xlsx", Status: "failed", ChunkCount: 0, Routes: []string{"sales", "marketing"}, UploadedAt: uploaded},
	}, 4)
	empty := docsBase(nil, 0)

	models := pageData{
		Title: "Models", CSRF: "preview", Username: "owner",
		Models: modelsView{
			Configured: false, Registered: 2, Running: 1,
			Kind: config.KindChat, Folders: []string{"Qwen3-BF16", "Whisper"}, ModelsDir: "/var/lib/veil-console/models",
			SuggestedPort: 8001,
			Form: modelForm{
				Command: config.CatalogCommand(chat[0], chat[0].Variants[0], 8001, 65536),
			},
			Rows: []modelRow{
				{
					ManagedModel: config.ManagedModel{
						ID: "qwen3.8-27b", DisplayName: "Qwen3.8 27B", Role: config.RoleChat,
						Command: config.CatalogCommand(chat[1], chat[1].Variants[0], 8001, 65536),
					},
					State: supervisor.ModelHealthy, StateText: "Serving", Running: true, IsDefault: true,
					Summary: "Qwen/Qwen3.8-27B-FP8 · 8-bit (FP8) · 256K context · port 8001",
				},
				{
					ManagedModel: config.ManagedModel{
						ID: "ornith-1.5-35b-a3b", DisplayName: "Ornith 1.5 35B A3B", Role: config.RoleChat,
						Command: config.CatalogCommand(chat[0], chat[0].Variants[0], 8002, 262144),
					},
					State: supervisor.ModelStopped, StateText: "Stopped",
					Summary: "ornith-ai/Ornith-1.5-35B-A3B-NVFP4 · 4-bit (NVFP4) · 256K context · port 8002",
				},
			},
		},
	}
	modelsDictation := models
	modelsDictation.Models.Kind = config.KindDictation
	modelsDictation.Models.Rows = nil
	modelsDictation.Models.Form = modelForm{
		Command: config.CatalogCommand(dictation[0], dictation[0].Variants[0], 8003, dictation[0].DefaultContext),
	}

	modelsEmpty := models
	modelsEmpty.Models.Rows = nil
	modelsEmpty.Models.Registered = 0

	settingsPage := pageData{
		Title: "Settings", CSRF: "preview", Username: "owner",
		Config:           config.DefaultVeil(),
		DefaultModelName: "Qwen3.8 27B",
		ContextLabel:     "256K",
		Models:           modelsView{Registered: 2},
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

	management := pageData{
		Title: "Management", CSRF: "preview", Configured: true, Running: true, EnterpriseEnabled: true,
		Access: accessView{Available: true, OrgName: "Example workspace", SeatsAssigned: 2, SeatsAvailable: 8, MaxAuthorizedUsers: 10, DevicesEnrolled: 1, MaxDevicesPerUser: 2, Filter: "active",
			Users: []accessUserView{
				{UID: "preview-user-1", Label: "Example administrator", StatusLabel: "Active", LastSeenRelative: "5 minutes ago", EnrolledDevices: 1, DevicesAvailable: 1, MaxDevicesPerUser: 2, CanManageDevices: true, Devices: []accessDeviceView{{UID: "preview-device-1", Label: "Workstation", LastSeenRelative: "5 minutes ago"}}},
				{UID: "preview-user-2", Label: "Example teammate", StatusLabel: "Awaiting enrollment", AwaitingEnrollment: true, DevicesAvailable: 2, MaxDevicesPerUser: 2},
			},
		},
	}
	pages := []struct {
		file, tmpl string
		data       pageData
	}{
		{"management.html", "access.html", management},
		{"setup.html", "setup.html", pageData{Title: "Create owner", CSRF: "preview"}},
		{"login.html", "login.html", pageData{Title: "Sign in", CSRF: "preview"}},
		{"token.html", "token.html", pageData{Title: "Client token", Token: "EXAMPLE-ONLY-NOT-A-VALID-TOKEN"}},
		{"enrollment.html", "enrollment-code-created.html", pageData{Title: "Enrollment code", CSRF: "preview", EnrollmentCode: "EXAMPLE-ONLY", EnrollmentExpires: "in 15 minutes"}},
		{"documents.html", "documents.html", filled},
		{"documents-empty.html", "documents.html", empty},
		{"documents-error.html", "documents.html", errored},
		{"models.html", "models.html", models},
		{"models-empty.html", "models.html", modelsEmpty},
		{"models-dictation.html", "models.html", modelsDictation},
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
