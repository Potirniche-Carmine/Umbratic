package config

import "testing"

// The catalog's job is to be the one place a model's serving facts live. These
// hold that: every row has to be startable, and every row's sampling has to be
// findable from the command it produced, because that lookup is what applies
// the card's numbers when the default model changes.
func TestEveryCatalogRowProducesAStartableCommand(t *testing.T) {
	for _, entry := range ServingCatalog {
		if len(entry.Variants) == 0 {
			t.Fatalf("%s offers no precision", entry.Key)
		}
		for _, variant := range entry.Variants {
			model := ManagedModel{
				ID:          entry.ServedID,
				DisplayName: entry.DisplayName,
				Command:     CatalogCommand(entry, variant, SuggestedPortStart),
			}
			if err := model.Validate(); err != nil {
				t.Fatalf("%s/%s does not validate: %v", entry.Key, variant.Key, err)
			}
			facts, err := model.Parse()
			if err != nil {
				t.Fatalf("%s/%s does not parse: %v", entry.Key, variant.Key, err)
			}
			if facts.ModelPath != variant.Repo {
				t.Fatalf("%s/%s serves %q, not %q", entry.Key, variant.Key, facts.ModelPath, variant.Repo)
			}
			found, ok := CatalogByRepo(facts.ModelPath)
			if !ok || found.Key != entry.Key {
				t.Fatalf("%s/%s cannot be found back from its repository", entry.Key, variant.Key)
			}
		}
	}
}

// A model the catalog has never heard of must leave the stored sampling alone
// rather than reset it to some house default.
func TestWithModelDefaultsAppliesCardSamplingAndHardcodesTheRest(t *testing.T) {
	entry, ok := CatalogEntry("qwen3.8-27b")
	if !ok {
		t.Fatal("qwen3.8-27b is missing from the catalog")
	}
	cfg := DefaultVeil()
	cfg.Temperature = 0.11
	cfg.MaxOutputTokens = 512
	applied := WithModelDefaults(cfg, entry.Variants[0].Repo)
	if applied.Temperature != entry.Temperature || applied.TopP != entry.TopP {
		t.Fatalf("card sampling was not applied: %+v", applied)
	}
	if applied.MaxOutputTokens != DefaultMaxOutputTokens || applied.MaxBodyBytes != DefaultMaxBodyBytes {
		t.Fatalf("server defaults were not refilled: %+v", applied)
	}
	if applied.ReasoningEffort != ReasoningNone {
		t.Fatal("reasoning effort must stay unset so the app can choose it per request")
	}
	custom := WithModelDefaults(cfg, "someone/their-own-finetune")
	if custom.Temperature != 0.11 {
		t.Fatalf("an unlisted model must keep its stored sampling: %+v", custom)
	}
}

func TestEmbeddingDefaultsAreOnAndKnownWidth(t *testing.T) {
	settings := DefaultRAG()
	if !settings.Enabled {
		t.Fatal("retrieval must be on out of the box")
	}
	if settings.Dimension != EmbeddingDimension(settings.EmbeddingModel) || settings.Dimension == 0 {
		t.Fatalf("the default embedding model has no recorded width: %+v", settings)
	}
	if err := settings.Validate(); err != nil {
		t.Fatalf("the defaults do not validate: %v", err)
	}
}
