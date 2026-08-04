package telemetry

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// Shared with the desktop producer test, which asserts that
// buildRedactedTelemetryBundle emits exactly these bytes.
const goldenBundlePath = "../../../../apps/desktop/tests/fixtures/telemetry-bundle.golden.json"

func goldenBundle(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(goldenBundlePath))
	if err != nil {
		t.Fatalf("read golden bundle: %v", err)
	}
	return raw
}

func TestDecodeBundleAcceptsGoldenFixture(t *testing.T) {
	raw := goldenBundle(t)
	bundle, sanitized, err := DecodeBundle(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("golden bundle rejected: %v", err)
	}
	if bundle.ExportedAt == "" || len(bundle.Tasks) != 1 || len(bundle.ProductEvents) != 1 {
		t.Fatalf("unexpected decoded bundle: %#v", bundle)
	}
	if bundle.LocalDiagnostics == nil {
		t.Fatal("localDiagnostics were dropped by the decoder")
	}
	var round map[string]any
	if err := json.Unmarshal(sanitized, &round); err != nil {
		t.Fatalf("sanitized bundle is not json: %v", err)
	}
	if len(round) != len(bundleFields) {
		t.Fatalf("sanitized bundle changed shape: %#v", round)
	}
}

func TestDecodeBundleRejectsVersionField(t *testing.T) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(goldenBundle(t), &fields); err != nil {
		t.Fatalf("parse golden bundle: %v", err)
	}
	fields["schemaVersion"] = json.RawMessage("6")
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("encode bundle: %v", err)
	}
	if _, _, err := DecodeBundle(bytes.NewReader(raw)); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("expected a versioned bundle to be rejected, got %v", err)
	}
}

func TestDecodeBundleRejectsMissingField(t *testing.T) {
	for _, name := range bundleFields {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(goldenBundle(t), &fields); err != nil {
			t.Fatalf("parse golden bundle: %v", err)
		}
		delete(fields, name)
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatalf("encode bundle: %v", err)
		}
		if _, _, err := DecodeBundle(bytes.NewReader(raw)); !errors.Is(err, ErrInvalidBundle) {
			t.Fatalf("expected a bundle without %s to be rejected, got %v", name, err)
		}
	}
}

func TestDecodeBundleRejectsInvalidLocalDiagnostics(t *testing.T) {
	for name, replacement := range map[string]string{
		"not an object":     `[]`,
		"missing counts":    `{"total":1}`,
		"negative count":    `{"total":-1,"warnings":0,"errors":0,"bySource":{},"byEvent":{}}`,
		"non-numeric count": `{"total":"1","warnings":0,"errors":0,"bySource":{},"byEvent":{}}`,
		"bad bucket":        `{"total":0,"warnings":0,"errors":0,"bySource":{"a":"b"},"byEvent":{}}`,
	} {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(goldenBundle(t), &fields); err != nil {
			t.Fatalf("parse golden bundle: %v", err)
		}
		fields["localDiagnostics"] = json.RawMessage(replacement)
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatalf("encode bundle: %v", err)
		}
		if _, _, err := DecodeBundle(bytes.NewReader(raw)); !errors.Is(err, ErrInvalidBundle) {
			t.Fatalf("expected %s localDiagnostics to be rejected, got %v", name, err)
		}
	}
}
