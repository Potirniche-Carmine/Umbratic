package state

import (
	"context"
	"testing"
	"umbratic-veil-console/internal/config"
)

func TestConnectionSurvivesReopen(t *testing.T) {
	ctx := context.Background()
	dir := tempStateDir(t)
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	c, err := store.Connection(ctx)
	if err != nil || c != config.DefaultConnection() {
		t.Fatalf("default: %+v %v", c, err)
	}
	c.Host, c.Port = "10.20.0.5", 9443
	if err := store.SaveConnection(ctx, c); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	got, err := store.Connection(ctx)
	if err != nil || got != c {
		t.Fatalf("saved settings changed: %+v %v", got, err)
	}
}
