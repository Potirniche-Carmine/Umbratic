package web

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/extract"
	"umbratic-veil-console/internal/rag"
	"umbratic-veil-console/internal/state"
)

// documentsView is what the Documents page renders: the corpus grouped by the
// route that decides who can retrieve it.
type documentsView struct {
	Sections   []routeSection
	Documents  int
	Chunks     int
	MaxDocs    int
	MaxChunks  int
	Configured bool
	Dimension  int
}

type routeSection struct {
	Route     string
	Label     string
	Documents []state.Document
}

var routeLabels = map[string]string{
	"engineering": "Engineering",
	"sales":       "Sales",
	"marketing":   "Marketing",
	"all":         "All routes",
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
	settings := s.corpus.Settings()
	view := documentsView{
		Documents: totalDocuments, Chunks: totalChunks,
		MaxDocs: state.MaxDocuments, MaxChunks: state.MaxChunks,
		Configured: s.corpus.Configured(), Dimension: settings.Dimension,
	}
	for _, route := range config.Routes {
		section := routeSection{Route: route, Label: routeLabels[route], Documents: []state.Document{}}
		for _, document := range documents {
			if document.Route == route {
				section.Documents = append(section.Documents, document)
			}
		}
		view.Sections = append(view.Sections, section)
	}
	return pageData{
		Title: "Documents", CSRF: csrfCookie(r), RAG: settings, Corpus: view, Routes: config.Routes,
		Error: errorMessage, Notice: noticeMessage,
	}
}

func (s *Server) documentsUpload(w http.ResponseWriter, r *http.Request) {
	route := strings.TrimSpace(r.FormValue("route"))
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
	document, err := s.corpus.Save(r.Context(), header.Filename, route, data, time.Now())
	if err != nil {
		s.store.Audit(r.Context(), "documents.upload", "failure", time.Now())
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	s.store.Audit(r.Context(), "documents.upload", "success", time.Now())
	notice := fmt.Sprintf("%s queued for indexing.", document.Name)
	if !s.corpus.Configured() {
		notice = fmt.Sprintf("%s stored. Set an embedding runtime below to index it.", document.Name)
	}
	s.render(w, "documents.html", s.documentsData(r, "", notice))
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
	route := strings.TrimSpace(r.FormValue("route"))
	if err := s.corpus.Requeue(r.Context(), r.PathValue("document_id"), route); err != nil {
		s.store.Audit(r.Context(), "documents.retag", "failure", time.Now())
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	s.store.Audit(r.Context(), "documents.retag", "success", time.Now())
	http.Redirect(w, r, "/documents", http.StatusSeeOther)
}

func (s *Server) documentReindex(w http.ResponseWriter, r *http.Request) {
	if err := s.corpus.Requeue(r.Context(), r.PathValue("document_id"), ""); err != nil {
		s.store.Audit(r.Context(), "documents.reindex", "failure", time.Now())
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	s.store.Audit(r.Context(), "documents.reindex", "success", time.Now())
	http.Redirect(w, r, "/documents", http.StatusSeeOther)
}

// documentsSettingsTest probes the embedding runtime without saving anything,
// so an administrator can find a working model before committing to it.
func (s *Server) documentsSettingsTest(w http.ResponseWriter, r *http.Request) {
	settings, err := parseRAGSettings(r, s.corpus.Settings())
	if err != nil {
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	dimension, err := rag.Probe(r.Context(), settings)
	if err != nil {
		s.renderStatus(w, "documents.html", http.StatusBadGateway, s.documentsData(r, err.Error(), ""))
		return
	}
	data := s.documentsData(r, "", fmt.Sprintf("Embedding runtime answered with %d dimensions.", dimension))
	data.RAG = settings
	data.RAG.Dimension = dimension
	s.render(w, "documents.html", data)
}

// documentsSettingsApply is a settings change with the same weight as the model
// settings: it takes the owner password, restarts Veil so the new retrieval
// configuration is in force, and re-embeds the corpus when the model changed.
func (s *Server) documentsSettingsApply(w http.ResponseWriter, r *http.Request) {
	if err := s.confirmDocumentsPassword(w, r); err != nil {
		return
	}
	previous := s.corpus.Settings()
	settings, err := parseRAGSettings(r, previous)
	if err != nil {
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	if strings.TrimSpace(settings.EmbeddingModel) != "" {
		dimension, probeErr := rag.Probe(r.Context(), settings)
		if probeErr != nil {
			s.store.Audit(r.Context(), "documents.settings", "failure", time.Now())
			s.renderStatus(w, "documents.html", http.StatusBadGateway, s.documentsData(r, probeErr.Error(), ""))
			return
		}
		settings.Dimension = dimension
	}
	if err := settings.Validate(); err != nil {
		s.renderStatus(w, "documents.html", http.StatusBadRequest, s.documentsData(r, err.Error(), ""))
		return
	}
	reembed := settings.EmbeddingModel != previous.EmbeddingModel || settings.Dimension != previous.Dimension
	if settings.Dimension > 0 {
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
	notice := "Retrieval settings saved."
	if reembed {
		if err := s.corpus.RequeueAll(r.Context()); err != nil {
			s.renderStatus(w, "documents.html", http.StatusInternalServerError,
				s.documentsData(r, "Settings saved, but the corpus could not be queued for re-embedding.", ""))
			return
		}
		notice = "Retrieval settings saved. The corpus is being re-embedded with the new model."
	}
	if restartErr := s.restartVeilForRAG(r.Context()); restartErr != nil {
		notice += " Restart Veil from Overview to apply them."
	}
	s.store.Audit(r.Context(), "documents.settings", "success", time.Now())
	s.render(w, "documents.html", s.documentsData(r, "", notice))
}

// restartVeilForRAG applies the new child environment. A stopped Veil is left
// stopped; there is nothing to apply until an administrator starts it.
func (s *Server) restartVeilForRAG(ctx context.Context) error {
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

func parseRAGSettings(r *http.Request, current config.RAG) (config.RAG, error) {
	settings := current
	settings.Enabled = checkboxValue(r.FormValue("rag_enabled"))
	settings.EmbeddingBaseURL = strings.TrimSpace(r.FormValue("embedding_base_url"))
	settings.EmbeddingModel = strings.TrimSpace(r.FormValue("embedding_model"))
	settings.VectorBaseURL = strings.TrimSpace(r.FormValue("vector_base_url"))
	if value := strings.TrimSpace(r.FormValue("collection")); value != "" {
		settings.Collection = value
	}
	if value := strings.TrimSpace(r.FormValue("top_k")); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return settings, errors.New("results per request is invalid")
		}
		settings.TopK = parsed
	}
	if value := strings.TrimSpace(r.FormValue("max_injected_bytes")); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return settings, errors.New("injected context size is invalid")
		}
		settings.MaxInjectedBytes = parsed
	}
	if value := strings.TrimSpace(r.FormValue("rag_timeout")); value != "" {
		parsed, err := time.ParseDuration(value)
		if err != nil {
			return settings, errors.New("retrieval timeout is invalid")
		}
		settings.Timeout = parsed
	}
	if settings.EmbeddingModel != current.EmbeddingModel {
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
