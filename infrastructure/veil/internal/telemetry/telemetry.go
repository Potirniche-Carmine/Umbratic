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
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type Bundle struct {
	ExportedAt       string           `json:"exportedAt"`
	ProductEvents    []map[string]any `json:"productEvents"`
	LocalDiagnostics map[string]any   `json:"localDiagnostics"`
	Tasks            []map[string]any `json:"tasks"`
}

// bundleFields is the top-level shape a bundle must carry. Extra top-level keys
// are stripped and counted: a newer harness may export sections this build has
// no reader for, and that is not a reason to lose the sections it does read.
var bundleFields = []string{"exportedAt", "productEvents", "localDiagnostics", "tasks"}

var ErrInvalidBundle = errors.New("invalid telemetry bundle")

// Drops reports what a bundle carried that this build could not store. Records
// are dropped one at a time rather than failing the bundle: a single malformed
// task must not cost an operator the other nine hundred.
type Drops struct {
	Tasks           int
	ProductEvents   int
	Feedback        int
	FailedTools     int
	ContextTriggers int
	EventFields     int
	UnknownSections int
}

func (d Drops) Total() int {
	return d.Tasks + d.ProductEvents + d.Feedback + d.FailedTools +
		d.ContextTriggers + d.EventFields + d.UnknownSections
}

func DecodeBundle(reader io.Reader) (Bundle, []byte, Drops, error) {
	var drops Drops
	raw, err := io.ReadAll(reader)
	if err != nil {
		return Bundle{}, nil, drops, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil {
		return Bundle{}, nil, drops, fmt.Errorf("%w: malformed json", ErrInvalidBundle)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return Bundle{}, nil, drops, fmt.Errorf("%w: trailing json", ErrInvalidBundle)
	}
	if err := checkBundleFields(fields, &drops); err != nil {
		return Bundle{}, nil, drops, err
	}
	strict := json.NewDecoder(bytes.NewReader(raw))
	strict.UseNumber()
	var bundle Bundle
	if err := strict.Decode(&bundle); err != nil {
		return Bundle{}, nil, drops, fmt.Errorf("%w: malformed json", ErrInvalidBundle)
	}
	if err := sanitizeBundle(&bundle, &drops); err != nil {
		return Bundle{}, nil, drops, err
	}
	sanitized, err := json.Marshal(bundle)
	if err != nil {
		return Bundle{}, nil, drops, fmt.Errorf("%w: cannot encode bundle", ErrInvalidBundle)
	}
	noteDrops(drops)
	return bundle, sanitized, drops, nil
}

func checkBundleFields(fields map[string]json.RawMessage, drops *Drops) error {
	for _, name := range bundleFields {
		if _, exists := fields[name]; !exists {
			return fmt.Errorf("%w: %s is required", ErrInvalidBundle, name)
		}
	}
	for name := range fields {
		if !slices.Contains(bundleFields, name) {
			drops.UnknownSections++
		}
	}
	return nil
}

// sanitizeBundle keeps every record this build can store and drops the rest.
// Only the two conditions that make a bundle meaningless as a whole — an
// untrustworthy export timestamp, or more records than the caps allow — fail it.
func sanitizeBundle(bundle *Bundle, drops *Drops) error {
	if _, err := time.Parse(time.RFC3339Nano, bundle.ExportedAt); err != nil {
		return fmt.Errorf("%w: exportedAt must be RFC3339", ErrInvalidBundle)
	}
	if len(bundle.Tasks) > maxTasks {
		return fmt.Errorf("%w: too many tasks", ErrInvalidBundle)
	}
	if len(bundle.ProductEvents) > maxProductEvents {
		return fmt.Errorf("%w: too many product events", ErrInvalidBundle)
	}

	tasks := bundle.Tasks[:0]
	for _, task := range bundle.Tasks {
		if err := sanitizeTask(task, drops); err != nil {
			if isPrivacyViolation(err) {
				return err
			}
			drops.Tasks++
			continue
		}
		tasks = append(tasks, task)
	}
	bundle.Tasks = tasks

	events := bundle.ProductEvents[:0]
	for _, event := range bundle.ProductEvents {
		if err := sanitizeProductEvent(event, drops); err != nil {
			drops.ProductEvents++
			continue
		}
		events = append(events, event)
	}
	bundle.ProductEvents = events

	sanitizeLocalDiagnostics(bundle.LocalDiagnostics)
	return nil
}

const (
	maxTasks         = 1000
	maxProductEvents = 100000
	// maxEventFieldChars bounds a free-form event field. Anything longer is prose,
	// and prose is what the privacy rules exist to keep out of telemetry.
	maxEventFieldChars = 200
	maxEventFields     = 32
)

// privacyError marks a violation of the deny-list. Privacy is one of the two
// things Veil still rejects on, so it fails the whole bundle rather than quietly
// costing the caller one record — a harness leaking raw prompts has to find out.
type privacyError struct{ error }

// Unwrap keeps errors.Is(err, ErrInvalidBundle) true, so the route still reports
// the specific denied field rather than a generic failure.
func (e privacyError) Unwrap() error { return e.error }

func privacyViolation(format string, args ...any) error {
	return privacyError{fmt.Errorf(format, args...)}
}

func isPrivacyViolation(err error) bool {
	var violation privacyError
	return errors.As(err, &violation)
}

// privacyDeniedTaskFields never travel, whatever the harness calls itself.
// This list is the privacy contract and is the one thing that still rejects.
var privacyDeniedTaskFields = []string{
	"prompt", "originalRepoPath", "worktreePath", "baselineFiles", "reviewFiles", "events",
}

func sanitizeTask(task map[string]any, drops *Drops) error {
	if err := requiredString(task, "id", 128); err != nil {
		return err
	}
	for _, blocked := range privacyDeniedTaskFields {
		if _, exists := task[blocked]; exists {
			return privacyViolation("%w: raw task field %q is not allowed", ErrInvalidBundle, blocked)
		}
	}
	if value, exists := task["feedback"]; exists {
		kept, err := sanitizeFeedback(value, drops)
		if err != nil {
			return err
		}
		task["feedback"] = kept
	}
	if value, exists := task["failedTools"]; exists {
		kept, err := sanitizeFailedTools(value, drops)
		if err != nil {
			return err
		}
		task["failedTools"] = kept
	}
	if value, exists := task["contextTriggers"]; exists {
		kept, err := sanitizeContextTriggers(value, drops)
		if err != nil {
			return err
		}
		task["contextTriggers"] = kept
	}
	return nil
}

func sanitizeFeedback(value any, drops *Drops) ([]any, error) {
	feedback, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%w: feedback must be an array", ErrInvalidBundle)
	}
	if len(feedback) > 100 {
		return nil, fmt.Errorf("%w: too many feedback records", ErrInvalidBundle)
	}
	kept := make([]any, 0, len(feedback))
	for _, item := range feedback {
		record, ok := item.(map[string]any)
		if !ok {
			drops.Feedback++
			continue
		}
		if err := requiredString(record, "messageId", 128); err != nil {
			drops.Feedback++
			continue
		}
		conversation, ok := record["conversation"].([]any)
		if !ok || len(conversation) > 2000 {
			drops.Feedback++
			continue
		}
		if comment, exists := record["comment"]; exists {
			if text, ok := comment.(string); !ok || len(text) > 4000 {
				drops.Feedback++
				continue
			}
		}
		malformed := false
		for _, message := range conversation {
			entry, ok := message.(map[string]any)
			if !ok {
				malformed = true
				break
			}
			if requiredString(entry, "content", 4<<20) != nil || requiredString(entry, "taskId", 128) != nil {
				malformed = true
				break
			}
		}
		if malformed {
			drops.Feedback++
			continue
		}
		kept = append(kept, record)
	}
	return kept, nil
}

func sanitizeFailedTools(value any, drops *Drops) ([]any, error) {
	tools, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%w: failedTools must be an array", ErrInvalidBundle)
	}
	if len(tools) > 2000 {
		return nil, fmt.Errorf("%w: too many failed tools", ErrInvalidBundle)
	}
	kept := make([]any, 0, len(tools))
	for _, item := range tools {
		record, ok := item.(map[string]any)
		if !ok {
			drops.FailedTools++
			continue
		}
		// Privacy, not vocabulary: a raw input or response dump fails the whole
		// bundle rather than being quietly discarded, so the harness bug is seen.
		if _, exists := record["input"]; exists {
			return nil, privacyViolation("%w: failed tool input dumps are not allowed", ErrInvalidBundle)
		}
		if _, exists := record["response"]; exists {
			return nil, privacyViolation("%w: failed tool response dumps are not allowed", ErrInvalidBundle)
		}
		if requiredString(record, "id", 160) != nil || requiredString(record, "toolKind", 80) != nil {
			drops.FailedTools++
			continue
		}
		if meta, ok := record["responseMeta"].(map[string]any); ok {
			if message, exists := meta["errorMessage"]; exists {
				if text, ok := message.(string); !ok || len(text) > 400 {
					drops.FailedTools++
					continue
				}
			}
		}
		kept = append(kept, record)
	}
	return kept, nil
}

// sanitizeContextTriggers bounds the list and keeps whatever thresholds the
// harness reports. The thresholds are a product decision that changes without
// a Veil release, so pinning them here only guaranteed drift.
func sanitizeContextTriggers(value any, drops *Drops) ([]any, error) {
	triggers, ok := value.([]any)
	if !ok || len(triggers) > 10000 {
		return nil, fmt.Errorf("%w: invalid context triggers", ErrInvalidBundle)
	}
	kept := make([]any, 0, len(triggers))
	for _, item := range triggers {
		trigger, ok := item.(map[string]any)
		if !ok {
			drops.ContextTriggers++
			continue
		}
		if !isBoundedScalar(trigger["threshold"]) {
			drops.ContextTriggers++
			continue
		}
		kept = append(kept, trigger)
	}
	return kept, nil
}

// sanitizeProductEvent accepts any event type. What a product event may contain
// is what stays enforced: an id, a real timestamp, a bounded number of fields,
// and no field big enough to smuggle prose.
func sanitizeProductEvent(event map[string]any, drops *Drops) error {
	if err := requiredString(event, "id", 128); err != nil {
		return err
	}
	eventType, ok := event["type"].(string)
	if !ok || strings.TrimSpace(eventType) == "" || len(eventType) > 128 {
		return fmt.Errorf("%w: product event type is required", ErrInvalidBundle)
	}
	at, _ := event["at"].(string)
	if _, err := time.Parse(time.RFC3339Nano, at); err != nil {
		return fmt.Errorf("%w: product event timestamp is invalid", ErrInvalidBundle)
	}
	if len(event) > maxEventFields {
		return fmt.Errorf("%w: product event has too many fields", ErrInvalidBundle)
	}
	for name, value := range event {
		if name == "id" || name == "type" || name == "at" {
			continue
		}
		if !isBoundedScalar(value) {
			delete(event, name)
			drops.EventFields++
		}
	}
	return nil
}

// isBoundedScalar is the privacy bound on free-form telemetry values: numbers,
// booleans, and strings too short to carry a prompt, a path, or a diff. Events
// group related values, so a shallow object or array of those is allowed too —
// the depth limit is what stops an arbitrary payload from riding along inside.
func isBoundedScalar(value any) bool {
	return isBoundedEventValue(value, 0)
}

const maxEventValueDepth = 2

func isBoundedEventValue(value any, depth int) bool {
	switch typed := value.(type) {
	case nil, bool, float64, json.Number:
		return true
	case string:
		return len(typed) <= maxEventFieldChars
	case []any:
		if depth >= maxEventValueDepth || len(typed) > maxEventFields {
			return false
		}
		for _, item := range typed {
			if !isBoundedEventValue(item, depth+1) {
				return false
			}
		}
		return true
	case map[string]any:
		if depth >= maxEventValueDepth || len(typed) > maxEventFields {
			return false
		}
		for name, item := range typed {
			if len(name) > 128 || !isBoundedEventValue(item, depth+1) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// sanitizeLocalDiagnostics keeps the counters it recognizes and discards the
// rest. The summary is a convenience for an operator, never a reason to lose a
// bundle, so nothing here returns an error.
func sanitizeLocalDiagnostics(summary map[string]any) {
	if summary == nil {
		return
	}
	for key, value := range summary {
		bucket, isBucket := value.(map[string]any)
		if !isBucket {
			if !isNonNegativeCount(value) {
				delete(summary, key)
			}
			continue
		}
		if len(bucket) > 200 {
			delete(summary, key)
			continue
		}
		for name, count := range bucket {
			if strings.TrimSpace(name) == "" || len(name) > 128 || !isNonNegativeCount(count) {
				delete(bucket, name)
			}
		}
	}
}

func isNonNegativeCount(value any) bool {
	number, ok := value.(json.Number)
	if !ok {
		return false
	}
	parsed, err := number.Int64()
	return err == nil && parsed >= 0
}

func requiredString(value map[string]any, key string, limit int) error {
	text, ok := value[key].(string)
	if !ok || strings.TrimSpace(text) == "" || len(text) > limit {
		return fmt.Errorf("%w: %s is required", ErrInvalidBundle, key)
	}
	return nil
}

// pruneInterval damps the retention sweep. Pruning walks the whole directory,
// so doing it on every accepted bundle made the cost of storing one bundle grow
// with the number already stored; a sweep this often is well inside the
// resolution retention is expressed in.
const pruneInterval = 10 * time.Minute

// maxStoredBundles caps the directory independently of age. Retention alone
// bounds how old files get, not how many arrive, and an authenticated device
// that uploads in a loop would otherwise be free to exhaust inodes.
const maxStoredBundles = 20000

var (
	pruneMu   sync.Mutex
	lastPrune time.Time
)

func StoreBundle(directory string, raw []byte, now time.Time, retentionDays int) (string, error) {
	if directory == "" {
		return "", nil
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	if err := maybePrune(directory, now, retentionDays); err != nil {
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

func maybePrune(directory string, now time.Time, retentionDays int) error {
	pruneMu.Lock()
	defer pruneMu.Unlock()
	if now.Sub(lastPrune) < pruneInterval {
		return nil
	}
	lastPrune = now
	return prune(directory, now, retentionDays)
}

// prune removes bundles past retention, then removes the oldest of whatever
// remains until the directory is back under maxStoredBundles. One directory
// read serves both, because the expensive part is the walk, not the deletes.
func prune(directory string, now time.Time, retentionDays int) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	cutoff := now.Add(-time.Duration(retentionDays) * 24 * time.Hour)
	type stored struct {
		name    string
		modTime time.Time
	}
	kept := make([]stored, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "telemetry-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if retentionDays > 0 && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
			continue
		}
		kept = append(kept, stored{name: entry.Name(), modTime: info.ModTime()})
	}
	if len(kept) <= maxStoredBundles {
		return nil
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].modTime.Before(kept[j].modTime) })
	for _, entry := range kept[:len(kept)-maxStoredBundles] {
		_ = os.Remove(filepath.Join(directory, entry.name))
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
