package telemetry

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Bundle struct {
	SchemaVersion int              `json:"schemaVersion"`
	ExportedAt    string           `json:"exportedAt"`
	ProductEvents []map[string]any `json:"productEvents"`
	Tasks         []map[string]any `json:"tasks"`
}

var ErrInvalidBundle = errors.New("invalid telemetry bundle")

func DecodeBundle(reader io.Reader) (Bundle, []byte, error) {
	raw, err := io.ReadAll(reader)
	if err != nil {
		return Bundle{}, nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var bundle Bundle
	if err := decoder.Decode(&bundle); err != nil {
		return Bundle{}, nil, fmt.Errorf("%w: malformed json", ErrInvalidBundle)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return Bundle{}, nil, fmt.Errorf("%w: trailing json", ErrInvalidBundle)
	}
	if err := validateBundle(bundle); err != nil {
		return Bundle{}, nil, err
	}
	sanitized, err := json.Marshal(bundle)
	if err != nil {
		return Bundle{}, nil, fmt.Errorf("%w: cannot encode bundle", ErrInvalidBundle)
	}
	return bundle, sanitized, nil
}

func validateBundle(bundle Bundle) error {
	if bundle.SchemaVersion != 4 {
		return fmt.Errorf("%w: unsupported schema version", ErrInvalidBundle)
	}
	if _, err := time.Parse(time.RFC3339Nano, bundle.ExportedAt); err != nil {
		return fmt.Errorf("%w: exportedAt must be RFC3339", ErrInvalidBundle)
	}
	if len(bundle.Tasks) > 1000 {
		return fmt.Errorf("%w: too many tasks", ErrInvalidBundle)
	}
	for _, task := range bundle.Tasks {
		if err := validateTask(task); err != nil {
			return err
		}
	}
	if len(bundle.ProductEvents) > 100000 {
		return fmt.Errorf("%w: too many product events", ErrInvalidBundle)
	}
	for _, event := range bundle.ProductEvents {
		if err := validateProductEvent(event); err != nil {
			return err
		}
	}
	return nil
}

func validateTask(task map[string]any) error {
	id, ok := task["id"].(string)
	if !ok || strings.TrimSpace(id) == "" || len(id) > 128 {
		return fmt.Errorf("%w: task id is required", ErrInvalidBundle)
	}
	for _, blocked := range []string{"prompt", "originalRepoPath", "worktreePath", "baselineFiles", "reviewFiles"} {
		if _, exists := task[blocked]; exists {
			return fmt.Errorf("%w: raw task field %q is not allowed", ErrInvalidBundle, blocked)
		}
	}
	if _, exists := task["events"]; exists {
		return fmt.Errorf("%w: raw task events are not allowed", ErrInvalidBundle)
	}
	if err := validateFeedback(task["feedback"]); err != nil {
		return err
	}
	if err := validateFailedTools(task["failedTools"]); err != nil {
		return err
	}
	if err := validateContextTriggers(task["contextTriggers"]); err != nil {
		return err
	}
	return nil
}

func validateFeedback(value any) error {
	feedback, ok := value.([]any)
	if !ok {
		return fmt.Errorf("%w: feedback must be an array", ErrInvalidBundle)
	}
	if len(feedback) > 100 {
		return fmt.Errorf("%w: too many feedback records", ErrInvalidBundle)
	}
	for _, item := range feedback {
		record, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("%w: feedback record must be an object", ErrInvalidBundle)
		}
		if err := requiredString(record, "messageId", 128); err != nil {
			return err
		}
		rating, _ := record["rating"].(string)
		if rating != "good" && rating != "bad" {
			return fmt.Errorf("%w: invalid feedback rating", ErrInvalidBundle)
		}
		if comment, exists := record["comment"]; exists {
			if text, ok := comment.(string); !ok || len(text) > 4000 {
				return fmt.Errorf("%w: invalid feedback comment", ErrInvalidBundle)
			}
		}
		conversation, ok := record["conversation"].([]any)
		if !ok || len(conversation) > 2000 {
			return fmt.Errorf("%w: invalid feedback conversation", ErrInvalidBundle)
		}
		for _, message := range conversation {
			entry, ok := message.(map[string]any)
			if !ok {
				return fmt.Errorf("%w: conversation message must be an object", ErrInvalidBundle)
			}
			role, _ := entry["role"].(string)
			if role != "user" && role != "assistant" {
				return fmt.Errorf("%w: invalid conversation role", ErrInvalidBundle)
			}
			if err := requiredString(entry, "content", 4<<20); err != nil {
				return err
			}
			if err := requiredString(entry, "taskId", 128); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateFailedTools(value any) error {
	tools, ok := value.([]any)
	if !ok {
		return fmt.Errorf("%w: failedTools must be an array", ErrInvalidBundle)
	}
	if len(tools) > 2000 {
		return fmt.Errorf("%w: too many failed tools", ErrInvalidBundle)
	}
	for _, item := range tools {
		record, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("%w: failed tool must be an object", ErrInvalidBundle)
		}
		if err := requiredString(record, "id", 160); err != nil {
			return err
		}
		if err := requiredString(record, "toolKind", 80); err != nil {
			return err
		}
		if _, exists := record["input"]; exists {
			return fmt.Errorf("%w: failed tool input dumps are not allowed", ErrInvalidBundle)
		}
		if _, exists := record["response"]; exists {
			return fmt.Errorf("%w: failed tool response dumps are not allowed", ErrInvalidBundle)
		}
		inputMeta, ok := record["inputMeta"].(map[string]any)
		if !ok {
			return fmt.Errorf("%w: failed tool inputMeta is required", ErrInvalidBundle)
		}
		if keys, exists := inputMeta["argKeys"]; exists {
			list, ok := keys.([]any)
			if !ok || len(list) > 40 {
				return fmt.Errorf("%w: failed tool argKeys are invalid", ErrInvalidBundle)
			}
		}
		responseMeta, ok := record["responseMeta"].(map[string]any)
		if !ok {
			return fmt.Errorf("%w: failed tool responseMeta is required", ErrInvalidBundle)
		}
		for _, key := range []string{"stdoutChars", "stderrChars", "toolResponseChars"} {
			if value, exists := responseMeta[key]; exists {
				switch typed := value.(type) {
				case float64:
					if typed < 0 {
						return fmt.Errorf("%w: failed tool %s must be a number", ErrInvalidBundle, key)
					}
				case json.Number:
					parsed, err := typed.Int64()
					if err != nil || parsed < 0 {
						return fmt.Errorf("%w: failed tool %s must be a number", ErrInvalidBundle, key)
					}
				default:
					return fmt.Errorf("%w: failed tool %s must be a number", ErrInvalidBundle, key)
				}
			}
		}
		if message, exists := responseMeta["errorMessage"]; exists {
			text, ok := message.(string)
			if !ok || len(text) > 400 {
				return fmt.Errorf("%w: failed tool errorMessage is invalid", ErrInvalidBundle)
			}
		}
	}
	return nil
}

func validateContextTriggers(value any) error {
	triggers, ok := value.([]any)
	if !ok || len(triggers) > 10000 {
		return fmt.Errorf("%w: invalid context triggers", ErrInvalidBundle)
	}
	for _, item := range triggers {
		trigger, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("%w: context trigger must be an object", ErrInvalidBundle)
		}
		threshold := fmt.Sprint(trigger["threshold"])
		if threshold != "75" && threshold != "90" {
			return fmt.Errorf("%w: invalid context threshold", ErrInvalidBundle)
		}
	}
	return nil
}

func validateProductEvent(event map[string]any) error {
	if err := requiredString(event, "id", 128); err != nil {
		return err
	}
	eventType, _ := event["type"].(string)
	allowed := map[string]bool{
		"review.opened": true, "ide.selected": true, "ide.opened": true,
		"task.accepted": true, "task.undone": true, "worktree.requested": true,
		"worktree.approved": true, "worktree.denied": true, "worktree.created": true,
		"worktree.kept": true,
	}
	if !allowed[eventType] {
		return fmt.Errorf("%w: invalid product event type", ErrInvalidBundle)
	}
	at, _ := event["at"].(string)
	if _, err := time.Parse(time.RFC3339Nano, at); err != nil {
		return fmt.Errorf("%w: product event timestamp is invalid", ErrInvalidBundle)
	}
	return nil
}

func requiredString(value map[string]any, key string, limit int) error {
	text, ok := value[key].(string)
	if !ok || strings.TrimSpace(text) == "" || len(text) > limit {
		return fmt.Errorf("%w: %s is required", ErrInvalidBundle, key)
	}
	return nil
}

func StoreBundle(directory string, raw []byte, now time.Time, retentionDays int) (string, error) {
	if directory == "" {
		return "", nil
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	if err := prune(directory, now, retentionDays); err != nil {
		return "", err
	}
	name := fmt.Sprintf("telemetry-%s-%s.json", now.UTC().Format("20060102T150405.000000000Z"), randomSuffix())
	filePath := filepath.Join(directory, name)
	temporaryPath := filepath.Join(directory, "."+name+".tmp")
	if err := os.WriteFile(temporaryPath, append(bytes.TrimSpace(raw), '\n'), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, filePath); err != nil {
		_ = os.Remove(temporaryPath)
		return "", err
	}
	return filePath, nil
}

func prune(directory string, now time.Time, retentionDays int) error {
	if retentionDays <= 0 {
		return nil
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	cutoff := now.Add(-time.Duration(retentionDays) * 24 * time.Hour)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "telemetry-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
		}
	}
	return nil
}

func randomSuffix() string {
	var data [4]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "00000000"
	}
	return hex.EncodeToString(data[:])
}
