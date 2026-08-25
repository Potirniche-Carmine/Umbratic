package websearch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func month(text string) time.Time {
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		panic(err)
	}
	return parsed
}

func TestLedgerSpendsTheMonthlyPoolOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "web-search-usage.json")
	ledger, err := OpenLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	now := month("2026-08-24T10:00:00Z")
	for attempt := range 3 {
		allowed, err := ledger.Reserve(3, now)
		if err != nil || !allowed {
			t.Fatalf("search %d inside the pool was refused: %v %v", attempt, allowed, err)
		}
	}
	if ledger.Available(3, now) {
		t.Fatal("a spent month still advertised room")
	}
	allowed, err := ledger.Reserve(3, now)
	if err != nil || allowed {
		t.Fatalf("the fourth search spent a pool of three: %v %v", allowed, err)
	}
}

// A budget that resets on restart is not a budget, and Veil restarts on every
// configuration change.
func TestLedgerSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "web-search-usage.json")
	now := month("2026-08-24T10:00:00Z")
	first, err := OpenLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if allowed, err := first.Reserve(2, now); err != nil || !allowed {
			t.Fatalf("reserve failed: %v %v", allowed, err)
		}
	}
	second, err := OpenLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	if allowed, err := second.Reserve(2, now); err != nil || allowed {
		t.Fatalf("a restart handed the month its pool back: %v %v", allowed, err)
	}
	if second.Available(2, now) {
		t.Fatal("a reopened spent month advertised room")
	}
}

func TestLedgerRollsOverOnTheUTCCalendarMonth(t *testing.T) {
	path := filepath.Join(t.TempDir(), "web-search-usage.json")
	ledger, err := OpenLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	august := month("2026-08-31T23:59:59Z")
	if allowed, err := ledger.Reserve(1, august); err != nil || !allowed {
		t.Fatalf("reserve failed: %v %v", allowed, err)
	}
	if allowed, _ := ledger.Reserve(1, august); allowed {
		t.Fatal("August's pool was spent twice")
	}
	september := month("2026-09-01T00:00:01Z")
	if !ledger.Available(1, september) {
		t.Fatal("the new month did not open")
	}
	if allowed, err := ledger.Reserve(1, september); err != nil || !allowed {
		t.Fatalf("September was refused August's spend: %v %v", allowed, err)
	}
	var stored ledgerFile
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal(data, &stored) != nil || stored.Month != "2026-09" || stored.Count != 1 {
		t.Fatalf("unexpected persisted state: %s", data)
	}
}

func TestLedgerLimits(t *testing.T) {
	now := month("2026-08-24T10:00:00Z")
	for _, trial := range []struct {
		name      string
		limit     int
		available bool
		reserves  bool
	}{
		{"bought nothing", 0, false, false},
		{"bought one", 1, true, true},
		{"shared-token mode", Unmetered, true, true},
	} {
		t.Run(trial.name, func(t *testing.T) {
			ledger, err := OpenLedger(filepath.Join(t.TempDir(), "web-search-usage.json"))
			if err != nil {
				t.Fatal(err)
			}
			if ledger.Available(trial.limit, now) != trial.available {
				t.Fatalf("Available(%d) = %v", trial.limit, !trial.available)
			}
			allowed, err := ledger.Reserve(trial.limit, now)
			if err != nil || allowed != trial.reserves {
				t.Fatalf("Reserve(%d) = %v, %v", trial.limit, allowed, err)
			}
		})
	}
}

func TestOpenLedgerRefusesAnUnreadableFile(t *testing.T) {
	directory := t.TempDir()
	for _, content := range []string{"not json", `{"month":"2026-08","count":-4}`} {
		path := filepath.Join(directory, "web-search-usage.json")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenLedger(path); err == nil {
			t.Fatalf("a corrupt ledger opened as a fresh month: %q", content)
		}
	}
}

func TestLedgerReserveIsAtomicUnderConcurrency(t *testing.T) {
	path := filepath.Join(t.TempDir(), "web-search-usage.json")
	ledger, err := OpenLedger(path)
	if err != nil {
		t.Fatal(err)
	}
	now := month("2026-08-24T10:00:00Z")
	const limit = 20
	var wait sync.WaitGroup
	granted := make(chan struct{}, 64)
	for range 64 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if allowed, err := ledger.Reserve(limit, now); err == nil && allowed {
				granted <- struct{}{}
			}
		}()
	}
	wait.Wait()
	if len(granted) != limit {
		t.Fatalf("a pool of %d granted %d searches", limit, len(granted))
	}
}
