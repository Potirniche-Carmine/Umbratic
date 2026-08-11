package web

import (
	"context"
	"sort"

	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/supervisor"
)

// settingsModelChoices is the Settings page's default-model dropdown.
//
// With managed models registered, the choice is among them: those are the
// runtimes Console launches, and a default naming anything else would point
// Veil at a process nobody starts. With none, it falls back to asking the
// configured provider what it is serving.
func settingsModelChoices(ctx context.Context, cfg config.Veil, managed []config.ManagedModel) []string {
	if len(managed) > 0 {
		ids := make([]string, 0, len(managed))
		for _, model := range managed {
			ids = append(ids, model.ID)
		}
		return ids
	}
	return probedModelChoices(ctx, cfg)
}

func probedModelChoices(ctx context.Context, cfg config.Veil) []string {
	models, err := supervisor.ListModels(ctx, cfg.ProviderBaseURL)
	if err != nil {
		return nil
	}
	if cfg.Model != "" {
		found := false
		for _, model := range models {
			found = found || model == cfg.Model
		}
		if !found {
			models = append(models, cfg.Model)
			sort.Strings(models)
		}
	}
	return models
}
