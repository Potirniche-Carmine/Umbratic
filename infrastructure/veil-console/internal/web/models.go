package web

import (
	"context"
	"sort"

	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/supervisor"
)

func settingsModels(ctx context.Context, cfg config.Veil) []string {
	models, err := supervisor.ListModels(ctx, cfg.Protocol, cfg.ProviderBaseURL)
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
