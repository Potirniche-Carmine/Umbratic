package web

import (
	"net/http/httptest"
	"strings"
	"testing"

	"umbratic-veil-console/internal/config"
)

func TestSettingsUseCustomChoicesAndShowEverySliderValue(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	response := httptest.NewRecorder()
	server.render(response, "settings.html", pageData{
		Title:  "Settings",
		Config: config.Veil{Protocol: "ollama", Model: "ornith:9b"},
		Models: []string{"ornith:9b"},
	})
	body := response.Body.String()
	for _, expected := range []string{
		`data-choice`, `data-choice-value="ornith:9b"`,
		`data-index="0">8K`, `data-index="3">64K`, `data-index="7">1M`,
		`data-index="0">16 MiB`, `data-index="4">256 MiB`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("Settings is missing %q: %s", expected, body)
		}
	}
	if strings.Contains(body, "<select") || strings.Contains(body, "range-ends") {
		t.Fatalf("Settings still uses the old controls: %s", body)
	}
}
