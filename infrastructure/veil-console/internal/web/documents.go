package web

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/extract"
	"umbratic-veil-console/internal/rag"
	"umbratic-veil-console/internal/state"
)

// documentsView is what the Documents page renders: the corpus as one list,
// newest first, with the route each document is available to as a column.
//
// It used to be grouped into a panel per route, which drew four upload boxes
// and four counts on a page that usually has nothing in it yet. Route is a
// property of a document, so it reads as a column.
type documentsView struct {
	All       []state.Document
	Documents int
	Chunks    int
	MaxDocs   int
	MaxChunks int
	Dimension int
}

// routeChoice is one option in the "Available to" menus, on the upload form and
// on every row.
type routeChoice struct {
	Route string
	Label string
	// Short is the label inside a table row, where three checkboxes have to fit
	// in a column beside five others.
	Short string
}

var routeShortLabels = map[string]string{
	"engineering": "Eng",
	"sales":       "Sales",
	"marketing":   "Mktg",
}

var routeLabels = map[string]string{
	"engineering": "Engineering",
	"sales":       "Sales",
	"marketing":   "Marketing",
}

func routeChoices() []routeChoice {
	choices := make([]routeChoice, 0, len(config.Routes))
	for _, route := range config.Routes {
		choices = append(choices, routeChoice{
			Route: route, Label: routeLabels[route], Short: routeShortLabels[route],
		})
	}
	return choices
}

// Upload bodies are bounded before anything is read: one file at a time, at the
// same 25 MiB the extractor accepts, plus a small allowance for the multipart
// framing and the CSRF field.
const maxUploadBytes = extract.MaxFileBytes + (1 << 20)

func (s *Server) documentsPage(w http.ResponseWriter, r *http.Request) {
	s.render(w, "documents.html", s.documentsData(r, "", ""))
}

func (s *Server) documentsData(r *http.Request, errorMessage, noticeMessage string) pageData {
	documents, err := s.store.Documents(r.Context())
	if err != nil && errorMessage == "" {
		errorMessage = "The document list could not be loaded."
	}
	totalDocuments, totalChunks, _ := s.store.CorpusTotals(r.Context())
	settings := s.corpus.Settings().WithDefaults()
	models, _ := s.store.ManagedModels(r.Context())
	choices := []config.EmbeddingChoice{}
	for _, model := range models {
		if config.NormalizeRole(model.Role) == config.RoleEmbedding {
			choices = append(choices, config.EmbeddingChoice{Model: model.ID, Label: model.DisplayName})
		}
	}
	view := documentsView{
		All:       documents,
		Documents: totalDocuments, Chunks: totalChunks,
		MaxDocs: state.MaxDocuments, MaxChunks: state.MaxChunks,
		Dimension: settings.Dimension,
	}
	return pageData{
		Title: "Documents", CSRF: csrfCookie(r), RAG: settings, Corpus: view,
		RouteChoices:     routeChoices(),
		EmbeddingChoices: choices,
		Error:            errorMessage, Notice: noticeMessage,
	}
}

func (s *Server) documentsUpload(w http.ResponseWriter, r *http.Request) {
	routes := config.NormalizeRoutes(r.Form["route"])
	file, header, err := r.FormFile("document")
	if err != nil {
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, "Choose a file to upload.", ""))
		return
	}
	defer file.Close()
	data := make([]byte, 0, header.Size)
	buffer := make([]byte, 32<<10)
	for len(data) <= extract.MaxFileBytes {
		read, readErr := file.Read(buffer)
		data = append(data, buffer[:read]...)
		if readErr != nil {
			break
		}
	}
	if len(data) > extract.MaxFileBytes {
		s.renderStatus(w, "documents.html", http.StatusRequestEntityTooLarge,
			s.documentsData(r, "That file is larger than 25 MiB.", ""))
		return
	}
	if _, err := s.corpus.Save(r.Context(), header.Filename, routes, data, time.Now()); err != nil {
		s.store.Audit(r.Context(), "documents.upload", "failure", time.Now())
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	s.store.Audit(r.Context(), "documents.upload", "success", time.Now())
	// No notice: the row appearing in the table with its status is the
	// confirmation, and a banner saying the same thing was one more toast to
	// stack up behind the last one.
	http.Redirect(w, r, "/documents", http.StatusSeeOther)
}

func (s *Server) documentDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("document_id")
	if err := s.corpus.Delete(r.Context(), id); err != nil {
		s.store.Audit(r.Context(), "documents.delete", "failure", time.Now())
		s.renderStatus(w, "documents.html", http.StatusBadGateway, s.documentsData(r, err.Error(), ""))
		return
	}
	s.store.Audit(r.Context(), "documents.delete", "success", time.Now())
	http.Redirect(w, r, "/documents", http.StatusSeeOther)
}

func (s *Server) documentRetag(w http.ResponseWriter, r *http.Request) {
	routes := config.NormalizeRoutes(r.Form["route"])
	if len(routes) == 0 {
		s.renderStatus(w, "documents.html", http.StatusBadRequest,
			s.documentsData(r, "A document has to be available to at least one team.", ""))
		return
	}
	if err := s.corpus.Requeue(r.Context(), r.PathValue("document_id"), routes); err != nil {
		s.store.Audit(r.Context(), "documents.retag", "failure", time.Now())
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	s.store.Audit(r.Context(), "documents.retag", "success", time.Now())
	http.Redirect(w, r, "/documents", http.StatusSeeOther)
}

func (s *Server) documentReindex(w http.ResponseWriter, r *http.Request) {
	if err := s.corpus.Requeue(r.Context(), r.PathValue("document_id"), nil); err != nil {
		s.store.Audit(r.Context(), "documents.reindex", "failure", time.Now())
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	s.store.Audit(r.Context(), "documents.reindex", "success", time.Now())
	http.Redirect(w, r, "/documents", http.StatusSeeOther)
}

// documentsSettingsApply is a settings change with the same weight as the model
// settings: it takes the owner password, restarts Veil so the new retrieval
// configuration is in force, and re-embeds the corpus when the model changed.
func (s *Server) documentsSettingsApply(w http.ResponseWriter, r *http.Request) {
	if err := s.confirmDocumentsPassword(w, r); err != nil {
		return
	}
	previous := s.corpus.Settings().WithDefaults()
	settings, err := s.parseRAGSettings(r, previous)
	if err != nil {
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	// The runtime is probed only when retrieval is being turned on. Turning it
	// off must not fail because the embedding runtime is already down — that is
	// the state someone is most likely switching out of.
	if settings.Enabled {
		dimension, probeErr := rag.Probe(r.Context(), settings)
		if probeErr != nil {
			s.store.Audit(r.Context(), "documents.settings", "failure", time.Now())
			s.renderStatus(w, "documents.html", http.StatusBadGateway, s.documentsSettingsError(r, settings, "Embedding model check failed: "+probeErr.Error()+". Check its status on Models."))
			return
		}
		settings.Dimension = dimension
	}
	if err := settings.Validate(); err != nil {
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	reembed := settings.EmbeddingModel != previous.EmbeddingModel || settings.Dimension != previous.Dimension
	if settings.Enabled && settings.Dimension > 0 {
		if err := s.corpus.EnsureCollection(r.Context(), settings.Dimension); err != nil {
			s.store.Audit(r.Context(), "documents.settings", "failure", time.Now())
			s.renderStatus(w, "documents.html", http.StatusBadGateway, s.documentsData(r, err.Error(), ""))
			return
		}
	}
	if err := s.store.SaveRAGSettings(r.Context(), settings); err != nil {
		s.store.Audit(r.Context(), "documents.settings", "failure", time.Now())
		s.renderStatus(w, "documents.html", http.StatusInternalServerError,
			s.documentsData(r, "Changes could not be saved.", ""))
		return
	}
	s.corpus.SetSettings(settings)
	s.supervisor.SetRAG(settings, s.qdrantAPIKey())
	if reembed {
		if err := s.corpus.RequeueAll(r.Context()); err != nil {
			s.renderStatus(w, "documents.html", http.StatusInternalServerError,
				s.documentsData(r, "Settings saved, but the corpus could not be queued for re-embedding.", ""))
			return
		}
	}
	if restartErr := s.restartVeilForChange(r.Context()); restartErr != nil {
		s.renderStatus(w, "documents.html", http.StatusInternalServerError,
			s.documentsData(r, "Settings saved, but Veil could not be restarted. Restart it from Overview to apply them.", ""))
		return
	}
	s.store.Audit(r.Context(), "documents.settings", "success", time.Now())
	http.Redirect(w, r, "/documents", http.StatusSeeOther)
}

// restartVeilForChange hands Veil its new child environment. Retrieval settings
// and the default model both live in it, and neither is read again until the
// process restarts. A stopped Veil is left stopped; there is nothing to apply
// until an administrator starts it.
func (s *Server) restartVeilForChange(ctx context.Context) error {
	if !s.supervisor.Status().Running {
		return nil
	}
	cfg, ok, err := s.store.Configuration(ctx, "current")
	if err != nil || !ok {
		return errors.New("Veil is not configured")
	}
	return s.supervisor.Restart(ctx, cfg, s.currentSecrets().ControlToken)
}

func (s *Server) confirmDocumentsPassword(w http.ResponseWriter, r *http.Request) error {
	err := s.freshPassword(w, r)
	if err == nil {
		return nil
	}
	status := http.StatusInternalServerError
	data := s.documentsData(r, "Password confirmation failed. Try again.", "")
	if errors.Is(err, errPasswordConfirmation) {
		status = http.StatusUnauthorized
		data.Error = ""
		data.PasswordError = true
	}
	s.renderStatus(w, "documents.html", status, data)
	return err
}

// parseRAGSettings reads the only two retrieval decisions the page still
// offers. Everything else is a constant, refilled by WithDefaults so a stored
// row written when they were editable cannot pin an old value.
func (s *Server) parseRAGSettings(r *http.Request, current config.RAG) (config.RAG, error) {
	settings := current.WithDefaults()
	settings.Enabled = checkboxValue(r.FormValue("rag_enabled"))
	id := strings.TrimSpace(r.FormValue("embedding_model"))
	if id == "" && !settings.Enabled {
		return settings, nil
	}
	model, ok, err := s.store.ManagedModel(r.Context(), id)
	if err != nil || !ok || config.NormalizeRole(model.Role) != config.RoleEmbedding {
		return settings, errors.New("add and start a local embedding model on Models first")
	}
	settings.EmbeddingModel = model.ID
	settings.EmbeddingBaseURL = model.ProviderBaseURL()
	if id != current.EmbeddingModel {
		settings.Dimension = 0
	}
	return settings, nil
}

func checkboxValue(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "on", "true", "1", "yes":
		return true
	default:
		return false
	}
}

func (s *Server) documentsSettingsError(r *http.Request, settings config.RAG, message string) pageData {
	data := s.documentsData(r, message, "")
	data.RAG = settings
	return data
}
