package httpapi

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// modelAvailabilityTTL keeps a picker that reopens from probing every runtime
// on the box each time. Availability changes when an administrator starts or
// stops a model — a few seconds of staleness costs a dimmed row, not a wrong
// answer, because the chat request still lands on whichever model was named.
const modelAvailabilityTTL = 5 * time.Second

// modelAvailabilityProbes bounds concurrent probes so listing a large registry
// cannot open one connection per model at once.
const modelAvailabilityProbes = 4

type availabilityCache struct {
	mu        sync.Mutex
	checkedAt time.Time
	state     map[string]bool
}

type modelListEntry struct {
	ID               string          `json:"id"`
	Display          string          `json:"display"`
	ContextLength    int             `json:"context_length,omitempty"`
	Capabilities     map[string]bool `json:"capabilities"`
	Available        bool            `json:"available"`
	Default          bool            `json:"default"`
	ReasoningEfforts []string        `json:"reasoning_efforts"`
}

// handleModels answers what this Veil can route to. Registration is
// configuration and availability is live, so the two are separate fields rather
// than one list that quietly omits a stopped model — a client that has a
// stopped model selected needs to see it, dimmed, not watch it disappear.
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if s.cfg.DefaultModel == "" {
		writeJSON(w, http.StatusOK, map[string]any{"models": []modelListEntry{}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.RequestTimeout)
	defer cancel()

	available := s.modelAvailability(ctx)
	entries := make([]modelListEntry, 0, len(s.cfg.Models))
	for _, entry := range s.cfg.Models {
		display := entry.Display
		if display == "" {
			display = entry.ID
		}
		entries = append(entries, modelListEntry{
			ID:               entry.ID,
			Display:          display,
			ContextLength:    entry.ContextLength,
			Capabilities:     map[string]bool{"reasoning": s.model.ThinkingSupported(ctx, entry.ID)},
			Available:        available[entry.ID],
			Default:          entry.ID == s.cfg.DefaultModel,
			ReasoningEfforts: entry.ReasoningEfforts,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": entries})
}

func (s *Server) modelAvailability(ctx context.Context) map[string]bool {
	s.availability.mu.Lock()
	if s.availability.state != nil && time.Since(s.availability.checkedAt) < modelAvailabilityTTL {
		cached := s.availability.state
		s.availability.mu.Unlock()
		return cached
	}
	s.availability.mu.Unlock()

	state := make(map[string]bool, len(s.cfg.Models))
	var mu sync.Mutex
	var wait sync.WaitGroup
	slots := make(chan struct{}, modelAvailabilityProbes)
	for _, entry := range s.cfg.Models {
		wait.Add(1)
		go func(id string) {
			defer wait.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			reachable, err := s.model.Available(ctx, id)
			mu.Lock()
			state[id] = err == nil && reachable
			mu.Unlock()
		}(entry.ID)
	}
	wait.Wait()

	s.availability.mu.Lock()
	s.availability.state = state
	s.availability.checkedAt = time.Now()
	s.availability.mu.Unlock()
	return state
}
