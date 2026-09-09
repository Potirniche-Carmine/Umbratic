package web

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

func (s *Server) modelsDirectory() string {
	if s.startup.ModelsDir != "" {
		return s.startup.ModelsDir
	}
	return filepath.Join(s.startup.StateDir, "models")
}

func localModelFolders(directory string) ([]string, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, errors.New("The models folder could not be opened.")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, errors.New("The models folder could not be read.")
	}
	folders := []string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if _, err := resolveLocalModel(directory, entry.Name()); err == nil {
			folders = append(folders, entry.Name())
		}
	}
	return folders, nil
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
	info, err = os.Stat(filepath.Join(resolved, "config.json"))
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("The folder must contain config.json and all model files.")
	}
	return resolved, nil
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

// Only the fixed model directory can be opened. No browser-supplied path or
// command reaches the desktop launcher. Headless hosts retain the copy-path flow.
func (s *Server) modelsOpenFolder(w http.ResponseWriter, r *http.Request) {
	directory := s.modelsDirectory()
	if err := os.MkdirAll(directory, 0700); err != nil {
		s.modelActionResult(w, r, errors.New("The models folder could not be created."), "models.open-folder")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.CommandContext(ctx, "explorer.exe", directory)
	case "darwin":
		command = exec.CommandContext(ctx, "open", directory)
	default:
		if os.Getenv("WSL_DISTRO_NAME") != "" {
			path, err := exec.CommandContext(ctx, "wslpath", "-w", directory).Output()
			if err == nil {
				command = exec.CommandContext(ctx, "/mnt/c/Windows/explorer.exe", strings.TrimSpace(string(path)))
			}
		} else if os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
			command = exec.CommandContext(ctx, "xdg-open", directory)
		}
	}
	var openErr error
	if command == nil {
		openErr = errors.New("no desktop")
	} else {
		openErr = command.Run()
		// Explorer returns 1 after dispatching a folder to the desktop process.
		var exit *exec.ExitError
		if strings.HasSuffix(command.Path, "explorer.exe") && errors.As(openErr, &exit) && exit.ExitCode() == 1 {
			openErr = nil
		}
	}
	if openErr != nil {
		s.modelActionResult(w, r, errors.New("The file manager could not be opened. Copy the path and open it on the Console computer."), "models.open-folder")
		return
	}
	http.Redirect(w, r, modelsPath(requestKind(r)), http.StatusSeeOther)
}
