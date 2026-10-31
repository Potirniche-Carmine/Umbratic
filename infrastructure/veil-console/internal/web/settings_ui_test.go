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
		ContextLabel:     "256K",
	})
	body := response.Body.String()
	for _, expected := range []string{
		"Ornith 1.5 35B A3B",
		`name="max_concurrent_requests"`, `name="queue_timeout"`, `name="request_timeout"`,
		`name="max_output_tokens"`, `name="max_body_bytes"`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("Settings is missing %q: %s", expected, body)
		}
	}
	for _, gone := range []string{
		`name="temperature"`, `name="top_p"`, `name="reasoning_effort"`,
		`name="parallel_tool_calls"`, `name="thinking_token_budget"`,
		`name="provider_base_url"`, `name="model"`,
		// Context moved to the model, so the slider that set one number for
		// every model at once must not come back.
		`name="context_length"`, "context-slider", "range-ends", "<select",
		// The context readout and the registered count were decoration here:
		// both live on Models, where they can be acted on.
		"256K context", "registered</a></span>",
	} {
		if strings.Contains(body, gone) {
			t.Fatalf("Settings still carries the retired control %q: %s", gone, body)
		}
	}
}
