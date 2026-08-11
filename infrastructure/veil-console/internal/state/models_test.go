package state

import (
	"context"
	"testing"

	"umbratic-veil-console/internal/config"
)

func managedFixture() config.ManagedModel {
	return config.ManagedModel{
		ID: "qwen3-32b", DisplayName: "Qwen 32B", ModelPath: "Qwen/Qwen3-32B",
		Port: 8001, MaxModelLen: 32768, GPUMemoryUtilization: 0.45,
		KVCacheDType: config.KVCacheFP8, Reasoning: true,
	}
}

func TestManagedModelsRoundTripAndPreserveOrder(t *testing.T) {
	ctx := context.Background()
	store, err := Open(tempStateDir(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if models, err := store.ManagedModels(ctx); err != nil || len(models) != 0 {
		t.Fatalf("a fresh database registers nothing: %#v %v", models, err)
	}

	first := managedFixture()
	second := managedFixture()
	second.ID, second.Port, second.DisplayName, second.Reasoning = "small", 8002, "Small", false
	for _, model := range []config.ManagedModel{first, second} {
		if err := store.InsertManagedModel(ctx, model); err != nil {
			t.Fatal(err)
		}
	}

	models, err := store.ManagedModels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "qwen3-32b" || models[1].ID != "small" {
		t.Fatalf("insertion order is the listed order: %#v", models)
	}
	if models[0] != first {
		t.Fatalf("every field must survive the round trip: %#v", models[0])
	}
	if models[1].Reasoning {
		t.Fatal("an undeclared model must not read as reasoning")
	}

	found, ok, err := store.ManagedModel(ctx, "small")
	if err != nil || !ok || found.Port != 8002 {
		t.Fatalf("lookup by id must work: %#v %v %v", found, ok, err)
	}
	if _, ok, _ := store.ManagedModel(ctx, "absent"); ok {
		t.Fatal("an unregistered id must not resolve")
	}
}

func TestManagedModelUpdateAndDelete(t *testing.T) {
	ctx := context.Background()
	store, err := Open(tempStateDir(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	model := managedFixture()
	if err := store.InsertManagedModel(ctx, model); err != nil {
		t.Fatal(err)
	}

	model.DisplayName, model.MaxModelLen, model.KVCacheDType = "Qwen 32B (long)", 98304, config.KVCacheAuto
	if err := store.UpdateManagedModel(ctx, model); err != nil {
		t.Fatal(err)
	}
	stored, _, err := store.ManagedModel(ctx, model.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored != model {
		t.Fatalf("the update must be complete: %#v", stored)
	}

	missing := managedFixture()
	missing.ID = "never-registered"
	if err := store.UpdateManagedModel(ctx, missing); err == nil {
		t.Fatal("updating an unregistered model must fail rather than insert one")
	}

	if err := store.DeleteManagedModel(ctx, model.ID); err != nil {
		t.Fatal(err)
	}
	if models, _ := store.ManagedModels(ctx); len(models) != 0 {
		t.Fatalf("the row must be gone: %#v", models)
	}
	// Removing something already removed is not an error: the administrator
	// wanted it gone, and it is.
	if err := store.DeleteManagedModel(ctx, model.ID); err != nil {
		t.Fatal(err)
	}
}

// Two runtimes cannot share a port, and the schema is what guarantees it even
// if a future handler forgets to check.
func TestManagedModelPortsAreUniqueInTheSchema(t *testing.T) {
	ctx := context.Background()
	store, err := Open(tempStateDir(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if err := store.InsertManagedModel(ctx, managedFixture()); err != nil {
		t.Fatal(err)
	}
	clash := managedFixture()
	clash.ID = "other"
	if err := store.InsertManagedModel(ctx, clash); err == nil {
		t.Fatal("a second model on the same port must be refused by the database")
	}
	duplicate := managedFixture()
	duplicate.Port = 8002
	if err := store.InsertManagedModel(ctx, duplicate); err == nil {
		t.Fatal("a duplicate served id must be refused by the database")
	}
}

func TestNextFreeManagedPortSkipsWhatIsTaken(t *testing.T) {
	first, second := managedFixture(), managedFixture()
	second.ID, second.Port = "small", 8002
	if got := NextFreeManagedPort([]config.ManagedModel{first, second}, 8177, 8080); got != 8003 {
		t.Fatalf("the suggestion must skip registered ports, got %d", got)
	}
	console := managedFixture()
	console.Port = config.SuggestedPortStart
	if got := NextFreeManagedPort(nil, config.SuggestedPortStart, 8080); got != config.SuggestedPortStart+1 {
		t.Fatalf("the suggestion must skip Console's own port, got %d", got)
	}
}

// The migration ledger is forward-only and idempotent: reopening an existing
// database must not reapply a step or lose a row.
func TestManagedModelMigrationIsIdempotent(t *testing.T) {
	ctx := context.Background()
	dir := tempStateDir(t)
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.InsertManagedModel(ctx, managedFixture()); err != nil {
		t.Fatal(err)
	}
	store.Close()

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	models, err := reopened.ManagedModels(ctx)
	if err != nil || len(models) != 1 || models[0].ID != "qwen3-32b" {
		t.Fatalf("reopening must preserve the registry: %#v %v", models, err)
	}
}
