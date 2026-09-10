package web

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"umbratic-veil-console/internal/modelfolder"
)

func (s *Server) modelsDirectory() string {
	if s.startup.ModelsDir != "" {
		return s.startup.ModelsDir
	}
	return filepath.Join(s.startup.StateDir, "models")
}

func localModelFolders(directory string) ([]string, map[string]string, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, nil, errors.New("The models folder could not be opened.")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, nil, errors.New("The models folder could not be read.")
	}
	folders := []string{}
	issues := map[string]string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if _, err := resolveLocalModel(directory, entry.Name()); err == nil {
			folders = append(folders, entry.Name())
		} else if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			issues[entry.Name()] = err.Error()
		}
	}
	return folders, issues, nil
}

func resolveLocalModel(directory, name string) (string, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) || filepath.IsAbs(name) {
		return "", errors.New("Choose a local model folder.")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(directory, name))
	if err != nil {
		return "", errors.New("The model folder is missing or cannot be read.")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("The model must be a folder.")
	}
	return modelfolder.Folder(resolved)
}

var modelNameCharacters = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func localModelID(name string) string {
	id := strings.TrimLeft(modelNameCharacters.ReplaceAllString(name, "-"), ".-_")
	if id == "" {
		id = "model"
	}
	if len(id) > 128 {
		id = id[:128]
	}
	return id
}
