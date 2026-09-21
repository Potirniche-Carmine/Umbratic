package model

import (
	"context"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Re-execute the test binary as a deterministic CLI, including on Windows.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "--diffusion-model" {
		imageRuntimeFixture()
		return
	}
	os.Exit(m.Run())
}

func imageRuntimeFixture() {
	arg := func(name string) string {
		for i := 1; i+1 < len(os.Args); i++ {
			if os.Args[i] == name {
				return os.Args[i+1]
			}
		}
		return ""
	}
	prompt, err := os.ReadFile(arg("--prompt-file"))
	if err != nil || os.Getenv("VEIL_AUTH_TOKEN") != "" || strings.Contains(strings.Join(os.Args, " "), "private prompt") {
		os.Exit(2)
	}
	directory, _ := os.Getwd()
	if os.WriteFile(arg("--diffusion-model"), []byte(directory), 0600) != nil {
		os.Exit(3)
	}
	switch string(prompt) {
	case "cancel":
		time.Sleep(time.Hour)
	case "fail":
		os.Exit(4)
	case "malformed":
		_ = os.WriteFile(arg("--output"), []byte("not a PNG"), 0600)
	default:
		file, err := os.Create(arg("--output"))
		if err != nil {
			os.Exit(5)
		}
		_ = png.Encode(file, image.NewRGBA(image.Rect(0, 0, 512, 512)))
		_ = file.Close()
	}
}

func TestImageRuntimeOutputIsolationAndCleanup(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("VEIL_AUTH_TOKEN", "must-not-reach-child")
	for _, prompt := range []string{"private prompt", "malformed", "fail"} {
		t.Run(prompt, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "started")
			runtime := ImageRuntime{Binary: binary, Weights: marker, Encoder: "encoder", VAE: "vae"}
			data, err := runtime.Generate(context.Background(), ImageRequest{Prompt: prompt, Width: 512, Height: 512})
			if prompt == "private prompt" {
				if err != nil || len(data) == 0 {
					t.Fatalf("valid image failed: %v", err)
				}
			} else if err == nil || len(data) != 0 {
				t.Fatal("invalid output was accepted")
			}
			directory, err := os.ReadFile(marker)
			if err != nil {
				t.Fatal("fixture did not validate private prompt and environment:", err)
			}
			if _, err := os.Stat(string(directory)); !os.IsNotExist(err) {
				t.Fatal("private runtime directory leaked")
			}
		})
	}
}

func TestImageRuntimeCancellationKillsProcessAndRemovesPrompt(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "started")
	runtime := ImageRuntime{Binary: binary, Weights: marker, Encoder: "encoder", VAE: "vae"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := runtime.Generate(ctx, ImageRequest{Prompt: "cancel", Width: 512, Height: 512})
		done <- err
	}()
	deadline := time.After(5 * time.Second)
	var directory []byte
	for len(directory) == 0 {
		select {
		case <-deadline:
			t.Fatal("runtime did not start")
		case <-time.After(10 * time.Millisecond):
			directory, _ = os.ReadFile(marker)
		}
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled generation succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runtime survived cancellation")
	}
	if _, err := os.Stat(string(directory)); !os.IsNotExist(err) {
		t.Fatal("cancelled prompt directory leaked")
	}
}
