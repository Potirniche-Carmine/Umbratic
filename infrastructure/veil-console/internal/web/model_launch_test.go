package web

import (
	"strings"
	"testing"
)

func TestStartSavesVisibleCommandBeforeLaunching(t *testing.T) {
	s, handler, cookies, csrf, closeServer := signedInConsole(t)
	defer closeServer()
	form := modelFormValues(s, csrf, nil)
	authorizedPost(t, handler, cookies, "/models/create", form)
	form.Set("command", strings.Replace(form.Get("command"), "32768", "8192", 1))
	// This test server has no runtime. Launch fails, but the submitted command
	// must be the saved retry target, rather than the previous 32K command.
	authorizedPost(t, handler, cookies, "/models/qwen3-32b/start", form)
	model, ok, err := s.store.ManagedModel(t.Context(), "qwen3-32b")
	facts, parseErr := model.Parse()
	if err != nil || !ok || parseErr != nil || facts.MaxModelLen != 8192 {
		t.Fatalf("Start ignored the editor: %+v, %v", model, err)
	}
	form.Set("command", "serve ; invalid")
	authorizedPost(t, handler, cookies, "/models/qwen3-32b/restart", form)
	unchanged, _, _ := s.store.ManagedModel(t.Context(), "qwen3-32b")
	if unchanged.Command != model.Command {
		t.Fatal("invalid restart changed the saved command")
	}
}
