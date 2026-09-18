package web

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestModelOptionsAndStatusContract(t *testing.T) {
	s, handler, cookies, csrf, closeServer := signedInConsole(t)
	defer closeServer()
	form := modelFormValues(s, csrf, nil)
	form["reasoning_effort"] = []string{"on", "off", "low", "medium", "high", "xhigh", "max"}
	if response := authorizedPost(t, handler, cookies, "/models/create", form); response.Code != http.StatusSeeOther {
		t.Fatal(response.Body.String())
	}
	page := authorizedGet(t, handler, cookies, "/models").Body.String()
	for _, forbidden := range []string{"Other levels", "extra_efforts", "display_name", "Model ID"} {
		if strings.Contains(page, forbidden) {
			t.Fatalf("obsolete model option: %s", forbidden)
		}
	}
	for _, effort := range form["reasoning_effort"] {
		if !strings.Contains(page, `value="`+effort+`" checked`) {
			t.Fatalf("missing option %s", effort)
		}
	}
	form.Set("reasoning_effort", "ultra")
	if response := authorizedPost(t, handler, cookies, "/models/qwen3-32b/update", form); response.Code != http.StatusBadRequest {
		t.Fatal("custom effort accepted")
	}
	stored, _, _ := s.store.ManagedModel(t.Context(), "qwen3-32b")
	if stored.ReasoningEfforts != "on,off,low,medium,high,xhigh,max" {
		t.Fatal("invalid save changed options")
	}
	response := authorizedGet(t, handler, cookies, "/models/status")
	var status []struct {
		ID, State, Text, Logs string
		Running               bool
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &status) != nil || len(status) != 1 || status[0].ID != stored.ID || status[0].Text != "Stopped" || status[0].Running {
		t.Fatalf("incorrect status: %s", response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("model status may be cached")
	}
	if response := authorizedGet(t, handler, nil, "/models/status"); response.Code != http.StatusSeeOther {
		t.Fatal("anonymous status exposed")
	}
}

func TestAuxiliaryModelsUseAutomaticSettings(t *testing.T) {
	for _, kind := range []string{"dictation", "embedding"} {
		t.Run(kind, func(t *testing.T) {
			s, handler, cookies, csrf, closeServer := signedInConsole(t)
			defer closeServer()
			form := url.Values{"csrf": {csrf}, "folder": {"test-model"}, "kind": {kind}, "port": {"8009"}, "id": {"override"}, "command": {"invalid"}, "sampling_json": {"invalid"}, "reasoning_effort": {"high"}}
			if response := authorizedPost(t, handler, cookies, "/models/create", form); response.Code != http.StatusSeeOther {
				t.Fatal(response.Body.String())
			}
			models, _ := s.store.ManagedModels(t.Context())
			model := models[0]
			if !strings.HasSuffix(strings.ToLower(model.ID), "-"+kind) || model.SamplingJSON != "" || model.ReasoningEfforts != "" {
				t.Fatalf("bad auxiliary defaults: %+v", model)
			}
			if strings.Contains(model.Command, "max-model-len") {
				t.Fatal("auxiliary context must follow checkpoint")
			}
			page := authorizedGet(t, handler, cookies, "/models?kind="+kind).Body.String()
			for _, field := range []string{`name="id"`, `name="command"`, `name="sampling_json"`, `name="reasoning_effort"`} {
				if strings.Contains(page, field) {
					t.Fatalf("auxiliary form exposes %s", field)
				}
			}
			form.Set("role", "chat")
			if response := authorizedPost(t, handler, cookies, "/models/"+model.ID+"/update", form); response.Code != http.StatusSeeOther {
				t.Fatal(response.Body.String())
			}
			saved, _, _ := s.store.ManagedModel(t.Context(), model.ID)
			if saved != model {
				t.Fatal("auxiliary defaults changed through a forged form")
			}
		})
	}
}
