package state

import (
	"database/sql"
	"strings"

	"umbratic-veil-console/internal/config"
)

func applyModelNames(tx *sql.Tx) error {
	rows, err := tx.Query(`SELECT id,command,role,sampling_json FROM managed_models`)
	if err != nil {
		return err
	}
	var models []config.ManagedModel
	for rows.Next() {
		var model config.ManagedModel
		if err := rows.Scan(&model.ID, &model.Command, &model.Role, &model.SamplingJSON); err != nil {
			rows.Close()
			return err
		}
		models = append(models, model)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, model := range models {
		oldID := model.ID
		facts, err := model.Parse()
		if err != nil {
			return err
		}
		model = config.WithLocalModelDefaults(model, facts.ModelPath)
		model.ID = config.ModelNameForRole(model.ID, model.Role)
		if model.ID != oldID {
			for i, arg := range facts.Args {
				if arg == "--served-model-name" && i+1 < len(facts.Args) {
					facts.Args[i+1] = model.ID
				} else if strings.HasPrefix(arg, "--served-model-name=") {
					facts.Args[i] = "--served-model-name=" + model.ID
				}
			}
			model.Command = config.FormatCommand(facts.Args)
			if _, err := tx.Exec(`UPDATE rag_settings SET embedding_model=? WHERE embedding_model=?`, model.ID, oldID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`UPDATE managed_models SET id=?,command=?,sampling_json=? WHERE id=?`, model.ID, model.Command, model.SamplingJSON, oldID); err != nil {
			return err
		}
	}
	_, err = tx.Exec(`ALTER TABLE managed_models DROP COLUMN display_name`)
	return err
}
