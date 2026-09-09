package web

import (
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const maxModelImportBytes int64 = 256 << 30
const maxModelImportFiles = 10000

// Import streams to a private staging folder. No files are exposed in the
// model list until the whole request succeeds. Weight formats are not filtered.
func importModelFolder(reader *multipart.Reader, directory string) (string, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", errors.New("The models folder is not writable.")
	}
	staging, err := os.MkdirTemp(directory, ".import-")
	if err != nil {
		return "", errors.New("The import folder could not be created.")
	}
	defer os.RemoveAll(staging)
	folder := ""
	count := 0
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", errors.New("The transfer stopped or exceeded 256 GiB. Copy the folder on the server instead.")
		}
		count++
		name := part.FormName()
		pieces := strings.Split(name, "/")
		if count > maxModelImportFiles || len(name) > 1024 || len(pieces) < 2 || path.Clean(name) != name || strings.ContainsAny(name, "\\:\x00\r\n") {
			part.Close()
			return "", errors.New("The folder contains an invalid path or more than 10,000 files.")
		}
		for _, piece := range pieces {
			if piece == "" || piece == "." || piece == ".." {
				part.Close()
				return "", errors.New("Hidden files and relative paths cannot be imported.")
			}
		}
		if strings.HasPrefix(pieces[0], ".") {
			part.Close()
			return "", errors.New("The model folder name cannot start with a dot.")
		}
		if folder == "" {
			folder = pieces[0]
		}
		if folder != pieces[0] {
			part.Close()
			return "", errors.New("Choose one complete model folder at a time.")
		}
		filePath := filepath.Join(staging, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(filePath), 0700); err != nil {
			part.Close()
			return "", errors.New("The model files could not be written.")
		}
		file, err := os.OpenFile(filePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			part.Close()
			return "", errors.New("The folder contains duplicate files or cannot be written.")
		}
		_, copyErr := io.Copy(file, part)
		closeErr := file.Close()
		part.Close()
		if copyErr != nil || closeErr != nil {
			return "", errors.New("The transfer failed. Check free disk space and try again.")
		}
	}
	if count == 0 {
		return "", errors.New("Choose a complete model folder.")
	}
	if _, err := resolveLocalModel(staging, folder); err != nil {
		return "", err
	}
	target := filepath.Join(directory, folder)
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		return "", errors.New("A folder with this name already exists. Rename the new folder before importing it.")
	}
	if info, err := os.Stat(directory); err == nil && info.Mode()&os.ModeSetgid != 0 {
		if err := filepath.Walk(filepath.Join(staging, folder), func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			mode := os.FileMode(0660)
			if info.IsDir() {
				mode = os.ModeSetgid | 0770
			}
			return os.Chmod(path, mode)
		}); err != nil {
			return "", errors.New("Model folder permissions could not be set.")
		}
	}
	if err := os.Rename(filepath.Join(staging, folder), target); err != nil {
		return "", errors.New("The model folder could not be saved.")
	}
	return folder, nil
}

func (s *Server) modelsImport(w http.ResponseWriter, r *http.Request) {
	if !s.modelImportMu.TryLock() {
		http.Error(w, "Another folder is being imported. Wait for it to finish.", http.StatusConflict)
		return
	}
	defer s.modelImportMu.Unlock()
	// Extend deadlines only for this authenticated, bounded upload.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(time.Hour))
	_ = controller.SetWriteDeadline(time.Now().Add(time.Hour))
	r.Body = http.MaxBytesReader(w, r.Body, maxModelImportBytes)
	reader, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "Choose a model folder.", http.StatusBadRequest)
		return
	}
	folder, err := importModelFolder(reader, s.modelsDirectory())
	if err != nil {
		s.store.Audit(r.Context(), "models.import", "failure", time.Now())
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.store.Audit(r.Context(), "models.import", "success", time.Now())
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, folder)
}
