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
				ID:      entry.ServedID,
				Command: CatalogCommand(entry, variant, SuggestedPortStart, entry.DefaultContext),
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
	applied := WithModelDefaults(cfg, entry.Variants[0].Repo)
	if applied.Temperature != entry.Temperature || applied.TopP != entry.TopP {
		t.Fatalf("card sampling was not applied: %+v", applied)
	}
	if applied.MaxOutputTokens != DefaultMaxOutputTokens || applied.MaxBodyBytes != DefaultMaxBodyBytes {
		t.Fatalf("server defaults were not refilled: %+v", applied)
	}
	// Maximum output and request size are editable, so a value set on the
	// Settings page has to survive a change of default model.
	cfg.MaxOutputTokens = 4096
	cfg.MaxBodyBytes = 16 << 20
	kept := WithModelDefaults(cfg, entry.Variants[0].Repo)
	if kept.MaxOutputTokens != 4096 || kept.MaxBodyBytes != 16<<20 {
		t.Fatalf("an administrator's limits were overwritten: %+v", kept)
	}
	if applied.ReasoningEffort != ReasoningNone {
		t.Fatal("reasoning effort must stay unset so the app can choose it per request")
	}
	custom := WithModelDefaults(cfg, "someone/their-own-finetune")
	if custom.Temperature != 0.11 {
		t.Fatalf("an unlisted model must keep its stored sampling: %+v", custom)
	}
}

// Every row has to be reachable from a tab, offer a context ladder its weights
// can actually serve, and open on a rung inside it.
func TestEveryCatalogRowHasAKindAndAServableContext(t *testing.T) {
	for _, entry := range ServingCatalog {
		switch entry.Kind {
		case KindChat, KindDictation:
		default:
			t.Fatalf("%s has no kind, so no tab shows it", entry.Key)
		}
		choices := entry.ContextChoices()
		if len(choices) == 0 {
			t.Fatalf("%s offers no context this model can serve", entry.Key)
		}
		for _, choice := range choices {
			if choice.Tokens > entry.MaxModelLen {
				t.Fatalf("%s offers %d tokens past its %d ceiling", entry.Key, choice.Tokens, entry.MaxModelLen)
			}
		}
		if entry.ClampContext(entry.DefaultContext) != entry.DefaultContext {
			t.Fatalf("%s opens on a context it does not offer", entry.Key)
		}
		if entry.ClampContext(1<<30) == 1<<30 {
			t.Fatalf("%s accepted a context past its ceiling", entry.Key)
		}
	}
	if len(CatalogFor(KindChat)) == 0 || len(CatalogFor(KindDictation)) == 0 {
		t.Fatal("both tabs need at least one model")
	}
	if CatalogFor(KindDictation)[0].Kind != KindDictation {
		t.Fatal("CatalogFor returned the wrong kind")
	}
	if CatalogFor(KindChat)[0].Contexts == nil {
		t.Fatal("CatalogFor must fill the context ladder for the browser")
	}
	if NormalizeKind("nonsense") != KindChat || NormalizeKind("dictation") != KindDictation {
		t.Fatal("kind normalization is wrong")
	}
	if KindDictation.Role() != RoleSpeech || KindChat.Role() != RoleChat {
		t.Fatal("the tab must decide the role")
	}
}

func TestEmbeddingDefaultsWaitForLocalModel(t *testing.T) {
	settings := DefaultRAG()
	if settings.Enabled || settings.EmbeddingModel != "" || settings.Dimension != 0 {
		t.Fatalf("retrieval needs a local model first: %+v", settings)
	}
	if err := settings.Validate(); err != nil {
		t.Fatal(err)
	}
	settings.EmbeddingModel = "local-embedding"
	settings.EmbeddingBaseURL = "http://127.0.0.1:8009/v1"
	settings.Dimension = 1536
	got := settings.WithDefaults()
	if got.EmbeddingBaseURL != settings.EmbeddingBaseURL || got.Dimension != 1536 {
		t.Fatalf("local runtime settings lost: %+v", got)
	}
}
