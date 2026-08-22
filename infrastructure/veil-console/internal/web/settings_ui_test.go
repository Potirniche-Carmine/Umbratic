package web

import (
	"net/http/httptest"
	"strings"
	"testing"

	"umbratic-veil-console/internal/config"
)

// The Settings page is now about the deployment, not about the model. What it
// must not do is come back: a form field for temperature is a field that
// overrides the model's own recommended sampling the next time anyone saves.
func TestSettingsKeepsDeploymentFieldsAndDropsModelFields(t *testing.T) {
	server, closeServer := testServer(t)
	defer closeServer()
	response := httptest.NewRecorder()
	server.render(response, "settings.html", pageData{
		Title:            "Settings",
		Config:           config.Veil{Model: "ornith-1.5-35b-a3b"},
		DefaultModelName: "Ornith 1.5 35B A3B",
	})
	body := response.Body.String()
	for _, expected := range []string{
		"Ornith 1.5 35B A3B",
		`data-index="0">8K`, `data-index="3">64K`, `data-index="7">1M`,
		`name="max_concurrent_requests"`, `name="queue_timeout"`, `name="request_timeout"`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("Settings is missing %q: %s", expected, body)
		}
	}
	for _, gone := range []string{
		`name="temperature"`, `name="top_p"`, `name="reasoning_effort"`,
		`name="parallel_tool_calls"`, `name="max_output_tokens"`,
		`name="thinking_token_budget"`, `name="max_body_bytes"`,
		`name="provider_base_url"`, `name="model"`,
		"range-ends", "<select",
	} {
		if strings.Contains(body, gone) {
			t.Fatalf("Settings still carries the retired control %q: %s", gone, body)
		}
	}
}
