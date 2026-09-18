package state

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"umbratic-veil-console/internal/config"
)

// MaxManagedModels bounds the fleet. One vLLM process holds a share of a GPU,
// so a registry an order of magnitude past this is a mistake rather than a
// deployment.
const MaxManagedModels = 32

// ManagedModels returns the registered models in a stable order — the order the
// Models page lists them and the order VEIL_MODELS carries.
func (s *Store) ManagedModels(ctx context.Context) ([]config.ManagedModel, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id,command,role,enabled,reasoning_efforts,sampling_json FROM managed_models ORDER BY created_at ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	models := []config.ManagedModel{}
	for rows.Next() {
		var model config.ManagedModel
		if err := rows.Scan(&model.ID, &model.Command, &model.Role, &model.Enabled, &model.ReasoningEfforts, &model.SamplingJSON); err != nil {
			return nil, err
		}
		models = append(models, model)
	}
	return models, rows.Err()
}

func (s *Store) ManagedModel(ctx context.Context, id string) (config.ManagedModel, bool, error) {
	var model config.ManagedModel
	err := s.db.QueryRowContext(ctx,
		`SELECT id,command,role,enabled,reasoning_efforts,sampling_json FROM managed_models WHERE id=?`, id).
		Scan(&model.ID, &model.Command, &model.Role, &model.Enabled, &model.ReasoningEfforts, &model.SamplingJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return config.ManagedModel{}, false, nil
	}
	if err != nil {
		return config.ManagedModel{}, false, err
	}
	return model, true, nil
}

var ErrTooManyManagedModels = errors.New("the model registry is full")

func (s *Store) InsertManagedModel(ctx context.Context, model config.ManagedModel) error {
	existing, err := s.ManagedModels(ctx)
	if err != nil {
		return err
	}
	if len(existing) >= MaxManagedModels {
		return ErrTooManyManagedModels
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO managed_models(id,command,role,reasoning_efforts,sampling_json,created_at) VALUES(?,?,?,?,?,?)`,
		model.ID, model.Command, config.NormalizeRole(model.Role), model.ReasoningEfforts, model.SamplingJSON, time.Now().Unix())
	return err
}

// UpdateManagedModel rewrites everything but the id, which is the primary key
// and the name clients already have. Renaming a served id is a remove and an
// add, because a rename would silently break every client that stored it.
func (s *Store) UpdateManagedModel(ctx context.Context, model config.ManagedModel) error {
	result, err := s.db.ExecContext(ctx,
		`UPDATE managed_models SET command=?,role=?,reasoning_efforts=?,sampling_json=? WHERE id=?`,
		model.Command, config.NormalizeRole(model.Role), model.ReasoningEfforts, model.SamplingJSON, model.ID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) DeleteManagedModel(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM managed_models WHERE id=?", id)
	return err
}

// NextFreeManagedPort suggests the port a new model's command is prefilled
// with. A suggestion, not a reservation: the save still fails loudly if the
// port was taken in between.
func NextFreeManagedPort(models []config.ManagedModel, consolePort, veilPort int) int {
	taken := map[int]bool{consolePort: true, veilPort: true}
	for _, model := range models {
		taken[model.Port()] = true
	}
	for port := config.SuggestedPortStart; port <= config.SuggestedPortEnd; port++ {
		if !taken[port] {
			return port
		}
	}
	return config.SuggestedPortStart
}

// SetModelEnabled records administrator intent; service shutdown does not clear it.
func (s *Store) SetModelEnabled(ctx context.Context, id string, enabled bool) error {
	result, err := s.db.ExecContext(ctx, "UPDATE managed_models SET enabled=? WHERE id=?", enabled, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return sql.ErrNoRows
	}
	return err
}
