package web

import (
	"encoding/json"
	"net/http"
	"strings"

	"umbratic-veil-console/internal/supervisor"
)

// Status polling updates only liveness, never the administrator's editor.
func (s *Server) modelsStatus(w http.ResponseWriter, r *http.Request) {
	models, err := s.store.ManagedModels(r.Context())
	if err != nil {
		http.Error(w, "Model status unavailable", http.StatusInternalServerError)
		return
	}
	type row struct {
		ID      string                `json:"id"`
		State   supervisor.ModelState `json:"state"`
		Text    string                `json:"text"`
		Notice  string                `json:"notice"`
		Logs    string                `json:"logs"`
		Running bool                  `json:"running"`
	}
	result := make([]row, 0, len(models))
	for _, model := range models {
		status := s.models.Status(model.ID)
		running := status.PID > 0
		stale := running && s.models.RunningCommand(model.ID) != strings.TrimSpace(model.Command)
		item := row{ID: model.ID, State: status.State, Text: modelStateText(status), Running: running, Notice: modelNotice(model, running, stale)}
		if status.State == supervisor.ModelStarting || status.State == supervisor.ModelFailed {
			item.Logs = s.models.Logs(model.ID)
		}
		if status.State == supervisor.ModelFailed {
			item.Text, item.Notice = "Failed to start", status.Message
		}
		result = append(result, item)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}
