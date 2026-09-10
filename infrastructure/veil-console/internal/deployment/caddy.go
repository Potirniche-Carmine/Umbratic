package deployment

import (
	"context"
	"fmt"
	"io"
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
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "adapt", "--config", "-", "--adapter", "caddyfile")
	cmd.Stdin = strings.NewReader(c.Caddyfile(fmt.Sprintf("127.0.0.1:%d", veilPort)))
	cmd.Stdout = io.Discard
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("generated Caddy configuration failed validation: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}
