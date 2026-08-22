package config

import (
	"strconv"
	"strings"
)

// The serving catalog: the models Console offers to register, and the weights
// it serves each of them from.
//
// A closed, hand-reviewed list rather than a search over Hugging Face, for the
// same reason the desktop keeps one — a repository name typed into a box is a
// supply-chain decision, and the review belongs here rather than in whoever is
// setting the server up at the time. A repository this list does not name can
// still be registered: "Custom" hands the administrator the command box the
// Models page has always had, and what they type there is their call.
//
// This is a serving catalog, not a download catalog. vLLM fetches the weights
// itself, so nothing here pins a digest the way `modelCatalog.ts` does on the
// desktop; what is pinned is which repository each row means.

// ServingVariant is one precision a model is offered at.
//
// The desktop's ladder is a GGUF one — Q4_K_M through Q8_0 — because
// llama.cpp is what consumes it. A GPU server is not that: vLLM serves
// safetensors, and the formats that actually exist for it are NVFP4 at four
// bits, FP8 at eight, and the original BF16. The rungs are the same idea at
// the same three sizes; only the names are the ones the server's runtime uses.
type ServingVariant struct {
	// Key is the form value, stable across label changes.
	Key string
	// Label is what the menu shows.
	Label string
	// Repo is the Hugging Face reference vLLM is pointed at.
	Repo string
	// VRAMGiB is roughly what the weights want, before the KV cache. It picks
	// which rung is suggested and is printed beside each one; nothing is
	// withheld because of it.
	VRAMGiB int
}

const (
	VariantNVFP4 = "nvfp4"
	VariantFP8   = "fp8"
	VariantFull  = "full"
)

// ServingModel is one row of the catalog.
type ServingModel struct {
	// Key identifies the row in the add form.
	Key string
	// DisplayName is the human name, and what the model's card is titled with.
	DisplayName string
	// ServedID is what clients send as `model`. Lowercased and punctuation-safe
	// because it travels in URLs and in argv.
	ServedID string
	// Detail is the one line on the row that settles the choice. Size is not
	// the thing that separates these; whether their tool calling holds up is.
	Detail string
	// Uncensored marks a build with the safety training removed. Offered
	// deliberately, never suggested.
	Uncensored bool
	// MaxModelLen is the context this model is registered with by default.
	MaxModelLen int
	// Temperature and TopP are the model card's own recommended sampling, not
	// Console's taste. They are recorded here for the same reason the desktop
	// records them: reading them off the card once is what keeps every
	// deployment sampling the way the model was tuned for. Console applies the
	// default model's numbers to Veil when the default changes, which is why
	// the Settings page no longer asks for them.
	Temperature float64
	TopP        float64
	// GPUMemoryUtilization is the fraction of the card vLLM may reserve. A
	// model that shares a GPU with an embedding runtime gets less of it.
	GPUMemoryUtilization string
	// Variants are the precisions offered, the suggested one first.
	Variants []ServingVariant
}

// ServingCatalog is ordered from the lightest model to the most capable, and
// uncensored builds sit after the model they derive from.
var ServingCatalog = []ServingModel{
	{
		Key:         "ornith-1.5-35b-a3b",
		DisplayName: "Ornith 1.5 35B A3B",
		ServedID:    "ornith-1.5-35b-a3b",
		Detail:      "Trained for terminal coding agents and tool calling. Mixture-of-experts, so it answers fast for its size.",
		MaxModelLen: 262144,
		// The card's numbers for general use; it reproduces its benchmarks at
		// temperature 1.0, which is not what a shared server wants.
		Temperature:          0.6,
		TopP:                 0.95,
		GPUMemoryUtilization: "0.85",
		Variants: []ServingVariant{
			{Key: VariantNVFP4, Label: "4-bit (NVFP4)", Repo: "ornith-ai/Ornith-1.5-35B-A3B-NVFP4", VRAMGiB: 24},
			{Key: VariantFP8, Label: "8-bit (FP8)", Repo: "ornith-ai/Ornith-1.5-35B-A3B-FP8", VRAMGiB: 40},
			{Key: VariantFull, Label: "Full (BF16)", Repo: "ornith-ai/Ornith-1.5-35B-A3B", VRAMGiB: 76},
		},
	},
	{
		Key:                  "qwen3.8-27b",
		DisplayName:          "Qwen3.8 27B",
		ServedID:             "qwen3.8-27b",
		Detail:               "Reliable tool calling over long multi-step runs. The one to pick for agentic work.",
		MaxModelLen:          262144,
		Temperature:          1.0,
		TopP:                 0.95,
		GPUMemoryUtilization: "0.85",
		Variants: []ServingVariant{
			{Key: VariantFP8, Label: "8-bit (FP8)", Repo: "Qwen/Qwen3.8-27B-FP8", VRAMGiB: 32},
			{Key: VariantFull, Label: "Full (BF16)", Repo: "Qwen/Qwen3.8-27B", VRAMGiB: 60},
		},
	},
	{
		Key:         "qwen3.8-27b-obliterated",
		DisplayName: "Qwen3.8 27B Obliterated",
		ServedID:    "qwen3.8-27b-obliterated",
		Detail:      "Security and offensive research, with tool calling solid enough for agentic runs.",
		Uncensored:  true,
		MaxModelLen: 262144,
		// The card serves it with one set of numbers and draws no distinction
		// between its thinking and non-thinking modes.
		Temperature:          1.0,
		TopP:                 0.95,
		GPUMemoryUtilization: "0.85",
		Variants: []ServingVariant{
			// The FP8 build is a third-party requantization of the row below
			// it; the abliterators publish BF16 only. Named rather than
			// silently substituted, because whose rebuild it is matters.
			{Key: VariantFP8, Label: "8-bit (FP8)", Repo: "MrPewpy/Qwen3.8-27B-OBLITERATED-FP8", VRAMGiB: 32},
			{Key: VariantFull, Label: "Full (BF16)", Repo: "OBLITERATUS/Qwen3.8-27B-OBLITERATED", VRAMGiB: 60},
		},
	},
	{
		Key:         "deepseek-v4-flash",
		DisplayName: "DeepSeek V4 Flash",
		ServedID:    "deepseek-v4-flash",
		Detail:      "Long-context reasoning and code. Sparse, so it stays cheap to decode at a size that would not otherwise be.",
		MaxModelLen: 262144,
		Temperature: 0.6,
		TopP:        0.95,
		// A model this large is the only thing on its cards.
		GPUMemoryUtilization: "0.90",
		Variants: []ServingVariant{
			{Key: VariantNVFP4, Label: "4-bit (NVFP4)", Repo: "MJPansa/DeepSeek-V4-Flash-0731-NVFP4", VRAMGiB: 180},
			{Key: VariantFP8, Label: "8-bit (FP8)", Repo: "AtlasCloud/DeepSeek-V4-Flash-0731-FP8-DSpark", VRAMGiB: 340},
			{Key: VariantFull, Label: "Full (BF16)", Repo: "deepseek-ai/DeepSeek-V4-Flash-0731", VRAMGiB: 660},
		},
	},
	{
		Key:                  "ornith-1.5-397b",
		DisplayName:          "Ornith 1.5 397B",
		ServedID:             "ornith-1.5-397b",
		Detail:               "The most capable model here, and a multi-GPU deployment. Frontier-grade agentic work.",
		MaxModelLen:          262144,
		Temperature:          0.6,
		TopP:                 0.95,
		GPUMemoryUtilization: "0.90",
		Variants: []ServingVariant{
			{Key: VariantNVFP4, Label: "4-bit (NVFP4)", Repo: "ornith-ai/Ornith-1.5-397B-NVFP4", VRAMGiB: 210},
			{Key: VariantFP8, Label: "8-bit (FP8)", Repo: "ornith-ai/Ornith-1.5-397B-FP8", VRAMGiB: 400},
			{Key: VariantFull, Label: "Full (BF16)", Repo: "ornith-ai/Ornith-1.5-397B", VRAMGiB: 800},
		},
	},
}

// CatalogEntry returns the row with this key.
func CatalogEntry(key string) (ServingModel, bool) {
	for _, model := range ServingCatalog {
		if model.Key == key {
			return model, true
		}
	}
	return ServingModel{}, false
}

// CatalogVariant returns one precision of a row, falling back to the suggested
// one when the form named a rung this model does not offer.
func (m ServingModel) Variant(key string) ServingVariant {
	for _, variant := range m.Variants {
		if variant.Key == key {
			return variant
		}
	}
	return m.Variants[0]
}

// CatalogByRepo finds the row a registered model was built from, by the
// repository its command serves. This is what lets Console recover a model's
// recommended sampling without storing it a second time: the command is
// already the single source of truth, and the repository is in it.
func CatalogByRepo(repo string) (ServingModel, bool) {
	repo = strings.TrimSpace(repo)
	for _, model := range ServingCatalog {
		for _, variant := range model.Variants {
			if strings.EqualFold(variant.Repo, repo) {
				return model, true
			}
		}
	}
	return ServingModel{}, false
}

// CatalogCommand is the vLLM argument list for one catalog row at one
// precision. It is the same shape as anything typed into the command box —
// there is no second launch path — so a catalog model can be edited afterwards
// like any other.
func CatalogCommand(model ServingModel, variant ServingVariant, port int) string {
	args := []string{
		"serve", variant.Repo,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(port),
		"--served-model-name", model.ServedID,
		"--max-model-len", strconv.Itoa(model.MaxModelLen),
		"--gpu-memory-utilization", model.GPUMemoryUtilization,
		"--kv-cache-dtype", KVCacheFP8,
	}
	return FormatCommand(args)
}

// WithModelDefaults applies a model's card-recommended sampling to the Veil
// configuration, and hardcodes what the Settings page no longer asks for.
//
// This is where item nine actually lands. Temperature and top-p were fields on
// a form, which meant they were whatever the last administrator typed rather
// than what the model was tuned for; a fleet where the default model changes
// and the sampling does not is a fleet quietly serving Qwen's numbers to
// DeepSeek. Reading them off the catalog row the running weights came from is
// the only version of this that stays true after a model change.
//
// Reasoning effort is deliberately left at "none". It is not a server policy —
// it is a per-request choice the person asking the question makes in the app,
// and pinning it here would override them on every turn.
func WithModelDefaults(cfg Veil, repo string) Veil {
	if entry, ok := CatalogByRepo(repo); ok {
		cfg.Temperature = entry.Temperature
		cfg.TopP = entry.TopP
	}
	return WithServerDefaults(cfg)
}

// WithServerDefaults refills the settings that are constants now.
//
// Maximum output was a number box capped at 32768 and defaulted to 8192, which
// is a truncated answer waiting to happen on a model that reasons before it
// replies; it is the cap now. Request size was a five-stop slider nobody has a
// reason to move off 64 MiB. Parallel tool calls is on, which is what every
// model in the catalog supports and what agentic work needs.
func WithServerDefaults(cfg Veil) Veil {
	cfg.MaxOutputTokens = DefaultMaxOutputTokens
	cfg.MaxBodyBytes = DefaultMaxBodyBytes
	cfg.ParallelToolCalls = true
	cfg.ThinkingTokenBudget = nil
	cfg.ReasoningEffort = ReasoningNone
	return cfg
}

const (
	// DefaultMaxOutputTokens is the ceiling Veil validates against. A thinking
	// model spends output tokens before it says anything, so a lower number is
	// a cut-off reply rather than a saving.
	DefaultMaxOutputTokens = 32768
	// DefaultMaxBodyBytes covers a long conversation with attachments, and is
	// far below anything that would be a memory problem for the process.
	DefaultMaxBodyBytes = 64 << 20
)

// SuggestedVRAM is what this model costs at the precision it is offered at
// first, which is the number the menu prints beside its name.
func (m ServingModel) SuggestedVRAM() int {
	if len(m.Variants) == 0 {
		return 0
	}
	return m.Variants[0].VRAMGiB
}
