package websearch

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Unmetered is the monthly limit for a deployment with no entitlement document
// to read one from — shared-token mode, which is development only. The ledger
// still counts what was spent, so an operator can see the usage even where
// nothing caps it.
const Unmetered = -1

// Ledger is the organization's monthly search allowance, kept on disk.
//
// A monthly budget that resets when the process restarts is not a budget. Veil
// restarts on every configuration change and every Console-driven model swap,
// and each restart would hand the month back its full pool — so unlike the
// in-process rate limiters, this count outlives the process. It is rewritten
// under a mutex by temp file and rename, the way the identity store is.
//
// The month is a UTC calendar month, because the invoice is: an operator
// reconciling one should not have to know which timezone the server was started
// in.
type Ledger struct {
	mu    sync.Mutex
	path  string
	month string
	count int
}

// ledgerFile is the whole on-disk state: which month is being counted, and how
// far into it the organization is.
type ledgerFile struct {
	Month string `json:"month"`
	Count int    `json:"count"`
}

// OpenLedger reads the ledger at path. A missing file is a fresh month — the
// normal state on a server that has never searched. A file that exists but
// cannot be read is an error rather than a fresh month: the difference between
// them is a whole month's pool, and guessing in the organization's favor is
// how a corrupt file becomes an unbounded bill.
func OpenLedger(path string) (*Ledger, error) {
	ledger := &Ledger{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ledger, nil
		}
		return nil, fmt.Errorf("read web search usage: %w", err)
	}
	var stored ledgerFile
	if err := json.Unmarshal(data, &stored); err != nil || stored.Count < 0 {
		return nil, errors.New("web search usage file is invalid")
	}
	ledger.month, ledger.count = stored.Month, stored.Count
	return ledger, nil
}

// Available reports whether one more search would fit in this month's pool. It
// is what decides whether the feature name is advertised, so it answers the
// same question Reserve does and reaches the same conclusion.
func (l *Ledger) Available(limit int, now time.Time) bool {
	if l == nil || limit == 0 {
		return false
	}
	if limit < 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollLocked(now)
	return l.count < limit
}

// Reserve takes one unit of this month's pool.
//
// Taken before the search is sent, and never given back. The search provider
// bills the request whether or not it answers usefully, so counting only the
// successes would make a retry loop free to the organization and expensive to
// us.
func (l *Ledger) Reserve(limit int, now time.Time) (bool, error) {
	if l == nil {
		return false, errors.New("web search usage is not open")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollLocked(now)
	if limit >= 0 && l.count >= limit {
		return false, nil
	}
	next := l.count + 1
	// The write comes before the in-memory count so a spend Veil could not
	// record is a spend that does not happen. A budget it cannot persist is a
	// budget it cannot enforce past the next restart.
	if err := persistUsage(l.path, ledgerFile{Month: l.month, Count: next}); err != nil {
		return false, err
	}
	l.count = next
	return true, nil
}

// rollLocked starts a new month when the calendar has. The stored month is
// compared on each use rather than a rollover being scheduled: the process is
// usually not running at midnight on the first, and a pool that only rolled
// over while Veil happened to be up would strand a month of searches.
func (l *Ledger) rollLocked(now time.Time) {
	month := now.UTC().Format("2006-01")
	if l.month != month {
		l.month, l.count = month, 0
	}
}

func persistUsage(path string, data ledgerFile) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("write web search usage: %w", err)
	}
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := file.Write(payload); err != nil {
		return fmt.Errorf("write web search usage: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync web search usage: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close web search usage: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("replace web search usage: %w", err)
	}
	ok = true
	if directory, openErr := os.Open(filepath.Dir(path)); openErr == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}
