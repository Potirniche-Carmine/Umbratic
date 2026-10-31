package model

import (
	"bytes"
	"context"
	"errors"
	"image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// ImageRuntime is trusted deployment configuration, never request input.
// One short-lived process loads weights only while generating an image.
type ImageRuntime struct {
	Binary, Weights, Encoder, VAE string
}

type ImageRequest struct {
	Prompt string `json:"prompt"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

const MaxImageBytes = 16 << 20

func (runtime ImageRuntime) Generate(ctx context.Context, input ImageRequest) ([]byte, error) {
	directory, err := os.MkdirTemp("", "umbratic-image-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(directory)
	prompt := filepath.Join(directory, "prompt.txt")
	if err := os.WriteFile(prompt, []byte(input.Prompt), 0600); err != nil {
		return nil, err
	}
	output := filepath.Join(directory, "image.png")
	command := exec.CommandContext(ctx, runtime.Binary,
		"--diffusion-model", runtime.Weights, "--llm", runtime.Encoder, "--vae", runtime.VAE,
		"--prompt-file", prompt, "--output", output,
		"--width", strconv.Itoa(input.Width), "--height", strconv.Itoa(input.Height),
		"--steps", "20", "--cfg-scale", "6", "--sampling-method", "euler",
		"--seed", "-1", "--offload-to-cpu", "--diffusion-fa", "--vae-tiling", "--disable-image-metadata")
	command.Dir = directory
	command.Env = []string{}
	// Do not inherit provider credentials, proxies, or runtime overrides.
	for _, name := range []string{"HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"} {
		if value, ok := os.LookupEnv(name); ok {
			command.Env = append(command.Env, name+"="+value)
		}
	}
	// Runtime output can contain prompts and paths. It never reaches logs or clients.
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if err := command.Run(); err != nil {
		return nil, errors.New("image generation failed")
	}
	file, err := os.Open(output)
	if err != nil {
		return nil, errors.New("image output missing")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, MaxImageBytes+1))
	if err != nil || len(data) > MaxImageBytes {
		return nil, errors.New("image output exceeds limit")
	}
	size, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || size.Width != input.Width || size.Height != input.Height {
		return nil, errors.New("invalid image output")
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		return nil, errors.New("invalid image output")
	}
	return data, nil
}
