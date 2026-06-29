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
	Policy        Policy           `json:"policy"`
	Tasks         []map[string]any `json:"tasks"`
}

type Policy struct {
	Mode          string `json:"mode"`
	LocalEnabled  bool   `json:"localEnabled"`
	SyncEnabled   bool   `json:"syncEnabled"`
	RetentionDays int    `json:"retentionDays"`
	ExportFormat  string `json:"exportFormat"`
	Storage       string `json:"storage"`
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
	return bundle, raw, nil
}

func validateBundle(bundle Bundle) error {
	if bundle.SchemaVersion != 1 {
		return fmt.Errorf("%w: unsupported schema version", ErrInvalidBundle)
	}
	if _, err := time.Parse(time.RFC3339Nano, bundle.ExportedAt); err != nil {
		return fmt.Errorf("%w: exportedAt must be RFC3339", ErrInvalidBundle)
	}
	if err := validatePolicy(bundle.Policy); err != nil {
		return err
	}
	if len(bundle.Tasks) > 1000 {
		return fmt.Errorf("%w: too many tasks", ErrInvalidBundle)
	}
	for _, task := range bundle.Tasks {
		if err := validateTask(task); err != nil {
			return err
		}
	}
	return nil
}

func validatePolicy(policy Policy) error {
	if policy.Mode != "developer_toggle" && policy.Mode != "managed_required" && policy.Mode != "managed_disabled" {
		return fmt.Errorf("%w: invalid policy mode", ErrInvalidBundle)
	}
	if policy.ExportFormat != "redacted-json" {
		return fmt.Errorf("%w: invalid export format", ErrInvalidBundle)
	}
	if policy.Storage != "company-managed-telemetry" && policy.Storage != "task-event-snapshots" {
		return fmt.Errorf("%w: invalid storage", ErrInvalidBundle)
	}
	if policy.RetentionDays <= 0 || policy.RetentionDays > 3650 {
		return fmt.Errorf("%w: invalid retention", ErrInvalidBundle)
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
	if events, ok := task["events"].([]any); ok {
		for _, event := range events {
			eventMap, ok := event.(map[string]any)
			if !ok {
				return fmt.Errorf("%w: event must be an object", ErrInvalidBundle)
			}
			if eventType, ok := eventMap["type"].(string); !ok || eventType == "" {
				return fmt.Errorf("%w: event type is required", ErrInvalidBundle)
			}
			if data, ok := eventMap["data"].(map[string]any); ok {
				if err := validateEventData(data); err != nil {
					return err
				}
			}
		}
	}
	if probes, ok := task["capabilityProbes"].([]any); ok {
		for _, probe := range probes {
			if err := validateCapabilityProbe(probe); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateEventData(data map[string]any) error {
	for _, blocked := range []string{"prompt", "rawPrompt", "text", "rawText", "fullDiff", "commandOutput", "sourceContents"} {
		if _, exists := data[blocked]; exists {
			return fmt.Errorf("%w: raw event field %q is not allowed", ErrInvalidBundle, blocked)
		}
	}
	return nil
}

func validateCapabilityProbe(value any) error {
	probe, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("%w: capability probe must be an object", ErrInvalidBundle)
	}
	if id, ok := probe["id"].(string); !ok || strings.TrimSpace(id) == "" {
		return fmt.Errorf("%w: capability probe id is required", ErrInvalidBundle)
	}
	status, ok := probe["status"].(string)
	if !ok || (status != "available" && status != "missing" && status != "error" && status != "unknown") {
		return fmt.Errorf("%w: invalid capability probe status", ErrInvalidBundle)
	}
	category, ok := probe["category"].(string)
	if !ok || (category != "required" && category != "recommended" && category != "optional-engineering" && category != "optional-artifacts") {
		return fmt.Errorf("%w: invalid capability probe category", ErrInvalidBundle)
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
