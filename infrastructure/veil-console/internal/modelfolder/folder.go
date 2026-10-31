package modelfolder

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// A downloaded folder can be a standalone model, a snapshot, or an HF cache
// repository. Prefer the named main revision; never silently choose between
// different revisions when no main ref exists.
func Folder(root string) (string, error) {
	if ConfigExists(root) {
		return root, nil
	}
	snapshots := filepath.Join(root, "snapshots")
	entries, err := os.ReadDir(snapshots)
	if err != nil {
		return "", errors.New("No readable config.json or Hugging Face snapshots found.")
	}
	file, err := os.Open(filepath.Join(root, "refs", "main"))
	if err == nil {
		data, readErr := io.ReadAll(io.LimitReader(file, 129))
		file.Close()
		revision := strings.TrimSpace(string(data))
		if readErr != nil || len(data) > 128 || revision == "" || revision == "." || revision == ".." || strings.ContainsAny(revision, `/\`) {
			return "", errors.New("The Hugging Face main revision is invalid.")
		}
		selected := filepath.Join(snapshots, revision)
		if ConfigExists(selected) {
			return selected, nil
		}
		return "", errors.New("The main snapshot is incomplete or its linked files cannot be read. Copy the complete model cache folder, including blobs and snapshots.")
	}
	if !os.IsNotExist(err) {
		return "", errors.New("The Hugging Face main revision could not be read.")
	}
	selected := ""
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		candidate := filepath.Join(snapshots, entry.Name())
		if !ConfigExists(candidate) {
			continue
		}
		if selected != "" {
			return "", errors.New("Multiple snapshots found without a main revision.")
		}
		selected = candidate
	}
	if selected == "" {
		return "", errors.New("No readable model snapshot found. Copy the complete model cache folder, including blobs and snapshots.")
	}
	return selected, nil
}
func ConfigExists(directory string) bool {
	info, err := os.Stat(filepath.Join(directory, "config.json"))
	return err == nil && info.Mode().IsRegular()
}
