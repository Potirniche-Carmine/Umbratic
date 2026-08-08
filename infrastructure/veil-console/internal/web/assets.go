package web

// Embedded static assets and the liveness endpoint. These are the only handlers
// that answer without a session, so they are kept together and kept trivial:
// read one embedded file, set its type, write it.

import (
	"io"
	"net/http"
)

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, "ok\n")
}

func (s *Server) style(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/style.css")
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(payload)
}

func (s *Server) accessStyle(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/access.css")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(payload)
}

func (s *Server) settingsStyle(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/settings.css")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(payload)
}

func (s *Server) documentsStyle(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/documents.css")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(payload)
}

func (s *Server) script(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/console.js")
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(payload)
}

func (s *Server) logo(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/umbratic-icon.png")
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(payload)
}

func (s *Server) favicon(w http.ResponseWriter, _ *http.Request) {
	payload, err := content.ReadFile("assets/favicon.ico")
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/x-icon")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(payload)
}
