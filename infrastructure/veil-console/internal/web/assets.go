package web

// Embedded static assets and the liveness endpoint. These are the only handlers
// that answer without a session, so they are kept together and kept trivial:
// read one embedded file, set its type, write it.

import (
	"io"
	"net/http"
	"path"
	"strings"
)

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, "ok\n")
}

// assetTypes is the closed set of file kinds this server will serve. A file in
// assets/ whose extension is not here is not reachable, which is what keeps the
// handler below from turning the embedded filesystem into a general file
// server: the answer to "what can be fetched" is this table, not the directory
// listing.
var assetTypes = map[string]string{
	".css":  "text/css; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".png":  "image/png",
	".ico":  "image/x-icon",
	".svg":  "image/svg+xml",
	".woff": "font/woff",
}

// asset serves one embedded file from assets/ by name.
//
// This replaced a hand-written handler and a hand-written route per file, which
// looked harmless and was not: adding a stylesheet meant remembering to add two
// more things somewhere else, and forgetting produced a 404 that shows up as a
// page rendering with half its styling rather than as an error anyone would
// notice. `controls.css` shipped that way. There is nothing to forget now.
//
// The name is taken from a path value and never joined onto anything: it is
// rejected outright if it contains a separator or a dot segment, so there is no
// traversal to reason about, and it must match a known extension besides.
func (s *Server) asset(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("asset")
	if name == "" || name != path.Base(name) || strings.HasPrefix(name, ".") {
		http.NotFound(w, r)
		return
	}
	contentType, ok := assetTypes[strings.ToLower(path.Ext(name))]
	if !ok {
		http.NotFound(w, r)
		return
	}
	payload, err := content.ReadFile("assets/" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	// Every asset URL in a template carries a version query, so a long cache is
	// safe and a changed file is a changed URL.
	w.Header().Set("Cache-Control", "public, max-age=3600")
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
