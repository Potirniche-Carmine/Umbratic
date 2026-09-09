package deployment

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
	"umbratic-veil-console/internal/config"
)

// Parse the exact generated configuration with the bundled Caddy before
// installing dependencies or stopping an existing service. Adapt does not
// start listeners, provision certificates, or change system state.
func checkCaddyConfiguration(binary string, c config.Connection, veilPort int) error {
	if err := c.Validate(veilPort); err != nil {
		return err
	}
	file, err := createDeploymentTempFile("umbratic-caddy-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.WriteString(c.Caddyfile(fmt.Sprintf("127.0.0.1:%d", veilPort)))
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "adapt", "--config", file.Name(), "--adapter", "caddyfile")
	cmd.Stdout = io.Discard
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("generated Caddy configuration failed validation: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// Some macOS installations retain /tmp as a symlink after its private target
// was removed. Deployment runs under sudo, so it cannot rely on the invoking
// user's TMPDIR. Use the normal location first and a system temporary location
// as a safe fallback instead of failing before any deployment work begins.
func createDeploymentTempFile(pattern string) (*os.File, error) {
	var lastErr error
	for _, directory := range []string{os.TempDir(), "/var/tmp"} {
		file, err := os.CreateTemp(directory, pattern)
		if err == nil {
			return file, nil
		}
		lastErr = err
	}
	return nil, lastErr
}
