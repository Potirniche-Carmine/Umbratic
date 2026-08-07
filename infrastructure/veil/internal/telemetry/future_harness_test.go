package telemetry

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
)

// The telemetry half of the compatibility guarantee. See the root AGENTS.md and
// internal/policy/future_harness_test.go: every bundle here comes from a harness
// newer than this build and must be accepted, with anything unreadable dropped
// per record and counted rather than costing the whole bundle.

func bundleWith(t *testing.T, mutate func(fields map[string]json.RawMessage)) []byte {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(goldenBundle(t), &fields); err != nil {
		t.Fatalf("parse golden bundle: %v", err)
	}
	mutate(fields)
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("encode bundle: %v", err)
	}
	return raw
}

func TestFutureHarnessTelemetryEventsAreAccepted(t *testing.T) {
	raw := bundleWith(t, func(fields map[string]json.RawMessage) {
		fields["productEvents"] = json.RawMessage(`[
			{"id":"e1","type":"review.opened","at":"2026-01-01T00:00:08.000Z"},
			{"id":"e2","type":"skill.autoRefreshed","at":"2026-01-01T00:00:09.000Z","skillId":"rust","fromChecksum":"abc123"},
			{"id":"e3","type":"veil.capabilityMissing","at":"2026-01-01T00:00:10.000Z","feature":"orient.v2","data":{"probed":true,"attempts":3}}
		]`)
	})
	bundle, _, drops, err := DecodeBundle(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("events from a newer harness were rejected: %v", err)
	}
	if len(bundle.ProductEvents) != 3 {
		t.Fatalf("every well-formed event must be kept: %#v", bundle.ProductEvents)
	}
	if drops.ProductEvents != 0 || drops.EventFields != 0 {
		t.Fatalf("nothing here should have been dropped: %#v", drops)
	}
}

func TestFutureHarnessTelemetryDropsPerRecordNotPerBundle(t *testing.T) {
	raw := bundleWith(t, func(fields map[string]json.RawMessage) {
		fields["productEvents"] = json.RawMessage(`[
			{"id":"good","type":"task.accepted","at":"2026-01-01T00:00:08.000Z"},
			{"id":"no-timestamp","type":"task.accepted"},
			{"id":"blank-type","type":"   ","at":"2026-01-01T00:00:08.000Z"}
		]`)
	})
	bundle, _, drops, err := DecodeBundle(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("two bad events must not cost the bundle: %v", err)
	}
	if len(bundle.ProductEvents) != 1 || bundle.ProductEvents[0]["id"] != "good" {
		t.Fatalf("the good event must survive: %#v", bundle.ProductEvents)
	}
	if drops.ProductEvents != 2 {
		t.Fatalf("dropped events must be counted, got %#v", drops)
	}
}

// A field too large to be a measurement is prose, and prose is what the privacy
// rules exist to keep out. The event survives without it.
func TestFutureHarnessTelemetryStripsUnboundedEventFields(t *testing.T) {
	prose := make([]byte, maxEventFieldChars+1)
	for i := range prose {
		prose[i] = 'p'
	}
	encoded, err := json.Marshal(string(prose))
	if err != nil {
		t.Fatal(err)
	}
	raw := bundleWith(t, func(fields map[string]json.RawMessage) {
		fields["productEvents"] = json.RawMessage(`[{"id":"e1","type":"run.finished","at":"2026-01-01T00:00:08.000Z","durationMs":42,"summary":` + string(encoded) + `}]`)
	})
	bundle, _, drops, err := DecodeBundle(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("an oversized field must not fail the bundle: %v", err)
	}
	if len(bundle.ProductEvents) != 1 {
		t.Fatalf("the event must survive: %#v", bundle.ProductEvents)
	}
	event := bundle.ProductEvents[0]
	if _, present := event["summary"]; present {
		t.Fatal("prose-length field must be stripped")
	}
	if _, present := event["durationMs"]; !present {
		t.Fatal("bounded measurements must be kept")
	}
	if drops.EventFields != 1 {
		t.Fatalf("stripped fields must be counted: %#v", drops)
	}
}

// Context thresholds are a product decision that ships without a Veil release.
func TestFutureHarnessTelemetryAcceptsNewContextThresholds(t *testing.T) {
	raw := bundleWith(t, func(fields map[string]json.RawMessage) {
		fields["tasks"] = json.RawMessage(`[{"id":"task-1","contextTriggers":[{"threshold":60},{"threshold":85},{"threshold":95}]}]`)
	})
	bundle, _, _, err := DecodeBundle(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("new thresholds were rejected: %v", err)
	}
	triggers, _ := bundle.Tasks[0]["contextTriggers"].([]any)
	if len(triggers) != 3 {
		t.Fatalf("every threshold must be kept: %#v", triggers)
	}
}

// Privacy is the exception: it rejects, loudly, however new the harness is.
func TestFutureHarnessTelemetryCannotEscapeThePrivacyDenyList(t *testing.T) {
	for _, field := range privacyDeniedTaskFields {
		raw := bundleWith(t, func(fields map[string]json.RawMessage) {
			fields["tasks"] = json.RawMessage(`[{"id":"task-1","harnessVersion":"9.9.9",` +
				`"` + field + `":"secret"}]`)
		})
		if _, _, _, err := DecodeBundle(bytes.NewReader(raw)); !errors.Is(err, ErrInvalidBundle) {
			t.Fatalf("raw task field %q must still be refused, got %v", field, err)
		}
	}
	raw := bundleWith(t, func(fields map[string]json.RawMessage) {
		fields["tasks"] = json.RawMessage(`[{"id":"task-1","failedTools":[{"id":"t1","toolKind":"edit","input":{"path":"/secret"}}]}]`)
	})
	if _, _, _, err := DecodeBundle(bytes.NewReader(raw)); !errors.Is(err, ErrInvalidBundle) {
		t.Fatalf("raw tool input dumps must still be refused, got %v", err)
	}
}
