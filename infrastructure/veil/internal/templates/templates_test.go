package templates

import (
	"strings"
	"testing"

	"umbratic-veil/internal/model"
)

func TestDecodeValidatesAndSelectsMatchingTemplates(t *testing.T) {
	registry, err := Decode([]byte(`{
		"templates": [
			{
				"id": "sales-quarterly-review",
				"kind": "powerpoint",
				"displayName": "Sales Quarterly Review",
				"serverKey": "templates/powerpoint/sales-quarterly-review",
				"version": "2026-06",
				"tags": ["sales", "qbr"],
				"description": "Quarterly sales review deck.",
				"available": true,
				"checksum": "sha256:abc",
				"routes": ["sales/chat"]
			},
			{
				"id": "engineering-postmortem",
				"kind": "word",
				"displayName": "Engineering Postmortem",
				"serverKey": "templates/word/engineering-postmortem",
				"version": "2026-06",
				"tags": ["incident"],
				"description": "Incident postmortem document.",
				"available": true,
				"checksum": "sha256:def",
				"routes": ["engineering/chat"]
			}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}

	selected := registry.Select("sales/chat", []model.Message{{Role: "user", Content: "Create a QBR deck for the account."}})
	if len(selected) != 1 {
		t.Fatalf("got %d selected templates", len(selected))
	}
	if selected[0].ID != "sales-quarterly-review" {
		t.Fatalf("unexpected template %#v", selected[0])
	}
	if otherRoute := registry.Select("engineering/chat", []model.Message{{Role: "user", Content: "Create a QBR deck."}}); len(otherRoute) != 0 {
		t.Fatalf("route-scoped template leaked to engineering route: %#v", otherRoute)
	}
}

func TestRequestOverlayContainsOnlySelectedTemplateMetadata(t *testing.T) {
	registry, err := Decode([]byte(`[{
		"id": "sales-quarterly-review",
		"kind": "powerpoint",
		"displayName": "Sales Quarterly Review",
		"serverKey": "templates/powerpoint/sales-quarterly-review",
		"version": "2026-06",
		"tags": ["sales", "qbr"],
		"description": "Quarterly sales review deck.",
		"available": true,
		"checksum": "sha256:abc",
		"routes": ["sales/chat"]
	}]`))
	if err != nil {
		t.Fatal(err)
	}

	content := registry.RequestOverlay("sales/chat", []model.Message{{Role: "user", Content: "Please build a sales deck."}})
	if content == "" {
		t.Fatal("a matching route must produce a template overlay")
	}
	for _, want := range []string{"Server-managed artifact templates", "sales-quarterly-review", "templates/powerpoint/sales-quarterly-review", "sha256:abc", ".umbratic/templates/<kind>/<id>/"} {
		if !strings.Contains(content, want) {
			t.Fatalf("missing %q from protected context: %s", want, content)
		}
	}
}

func TestDecodeRejectsInvalidTemplates(t *testing.T) {
	if _, err := Decode([]byte(`[{"id":"missing-kind"}]`)); err == nil {
		t.Fatal("expected missing metadata error")
	}
	if _, err := Decode([]byte(`[{
		"id": "bad",
		"kind": "public-web",
		"displayName": "Bad",
		"serverKey": "bad",
		"version": "1",
		"available": true,
		"checksum": "sha256:bad"
	}]`)); err == nil {
		t.Fatal("expected unsupported kind error")
	}
}
