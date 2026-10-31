package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"testing"
	"time"

	"umbratic-veil/internal/model"
	"umbratic-veil/internal/prompts"
)

func TestDiagnosticsExcludeModelOutputAndTransportDetails(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	const sensitive = "token=never-log-this-secret\r\nforged record"
	recordOrientInvalidOutput(prompts.EngineeringChat, "invalid JSON", sensitive)
	recordModelFailure(prompts.EngineeringChat, "request", classifyModelFailure(model.ProviderError{Kind: model.ProviderFailureTransport, Cause: errors.New(sensitive)}, 0), model.ChatRequest{}, time.Second)
	if strings.Contains(output.String(), "never-log-this-secret") || strings.Contains(output.String(), "forged record") {
		t.Fatalf("diagnostics contained request content: %s", output.String())
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected two bounded diagnostic records, got %d", len(lines))
	}
	for _, line := range lines {
		_, payload, ok := strings.Cut(line, "VEIL_DIAGNOSTIC ")
		if !ok || !json.Valid([]byte(payload)) {
			t.Fatalf("invalid diagnostic record: %s", line)
		}
	}
}
