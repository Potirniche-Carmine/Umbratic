package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"umbratic-veil/internal/model"
)

func loadImageRuntime() (*model.ImageRuntime, error) {
	names := []string{"VEIL_IMAGE_BINARY", "VEIL_IMAGE_WEIGHTS", "VEIL_IMAGE_ENCODER", "VEIL_IMAGE_VAE"}
	values := make([]string, len(names))
	count := 0
	for i, name := range names {
		values[i] = strings.TrimSpace(os.Getenv(name))
		if values[i] != "" {
			count++
		}
	}
	if count == 0 {
		return nil, nil
	}
	if count != len(names) {
		return nil, errors.New("image generation requires the runtime, weights, text encoder, and VAE")
	}
	for _, value := range values {
		stat, err := os.Stat(value)
		if !filepath.IsAbs(value) || err != nil || !stat.Mode().IsRegular() {
			return nil, errors.New("image generation files must be existing absolute regular files")
		}
	}
	return &model.ImageRuntime{Binary: values[0], Weights: values[1], Encoder: values[2], VAE: values[3]}, nil
}
