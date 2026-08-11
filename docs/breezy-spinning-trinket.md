# Thinking Toggle + Model Picker + Multi-Model Veil/Console

## Context

Today the app has no user-facing control over model reasoning: the renderer hardcodes `reasoningMode = "reasoning"` (main.tsx:1880) and it never reaches the runner or Veil. Model choice is buried in the connection page, and in server mode there is no choice at all — the client gets a synthetic `"veil-managed"` model and the Veil server runs exactly one model fixed at startup (`VEIL_MODEL` env). Nothing in the repo launches vLLM; an admin starts it by hand.

This plan adds:
1. A **Think toggle** in the composer that forces thinking on/off end-to-end (Ollama `think`, vLLM `chat_template_kwargs.enable_thinking`), persisted in SQLite, restored at launch.
2. A **model picker** in the composer for both local (Ollama) and server (Veil) modes, plus a server-mode model picker on the connection page (local keeps its existing one).
3. **Multi-model Veil**: a model registry, a client-visible `GET /api/models`, per-request `model` selection.
4. **Veil Console model management**: add/edit/remove model entries and start/stop each one — the console spawns and supervises `vllm serve` child processes (one per model, own loopback port), with **8-bit KV cache (`--kv-cache-dtype fp8`) as the default**. (vLLM has no literal "q8"; fp8 is its 8-bit KV cache dtype. Doc note: local Ollama admins can set `OLLAMA_KV_CACHE_TYPE=q8_0`.)

**Confirmed product decisions**: console spawns vLLM itself (typed fields only, no free-form args); multiple models may run concurrently, each with its own `gpu-memory-utilization` fraction.

**Compat contract** (repo rules): additive and name-based only — new feature names in Veil `features.go`, no versioning anywhere, old clients work against new Veil and vice versa. Reasoning content stays private: `stripPrivateReasoning` (vLLM) and the Ollama `message.thinking` drop are unchanged — the toggle controls whether the model thinks, not whether thinking is shown.

## New contract surface (single source of truth)

**Feature names** (Veil `/api/health` `features`, mirrored in `apps/desktop/src/main/veilFeatures.ts`):
| Name | Advertised | Gates |
|---|---|---|
| `models.list` | always (new builds) | client may call `GET /api/models` |
| `chat.model_selection` | only when `VEIL_MODELS` set | client may send `model` in chat bodies |
| `chat.thinking_toggle` | always (new builds) | client may send `thinking` in chat bodies |

**`VEIL_MODELS`** (new env, server mode only) — JSON array of `{"id","provider_base_url","display","reasoning","context_length"}`. `id` required/unique (≤256 chars), `provider_base_url` required. When set: `VEIL_MODEL` must equal one entry's id (= default). Unset: byte-identical behavior to today (one-entry registry synthesized from `VEIL_MODEL`/`VEIL_PROVIDER_BASE_URL`/`VEIL_MODEL_REASONING`, `chat.model_selection` not advertised, `model` stays loudly rejected).

**`GET /api/models`** (product auth, both modes): `{"models":[{"id","display","context_length","capabilities":{"reasoning":bool},"available":bool,"default":bool}]}`. No version keys.

**Chat body additions** (client → Veil):
- `model: string` — accepted only when `chat.model_selection` advertised; must be a registry id else 400 (loud); absent → DefaultModel.
- `thinking: "on" | "off"` — tolerant hint like `harness_bucket`: unknown values treated as absent, never rejected. Absent → today's behavior.

**Veil → runtime mapping**:
- Ollama: when directive present AND the model's `api/show` `capabilities` contains `"thinking"` (cached per model) → `"think": true|false`; capability absent/unknown → omit entirely (some Ollama versions error on `think` for non-thinking models). No directive → today's body.
- vLLM: directive present → `"chat_template_kwargs": {"enable_thinking": bool}`. Directive `off` → also force `ReasoningEffort=none` / `ThinkingTokenBudget=nil` **in `handleChat` before body build** (the `doVLLMChat` guard only skips `ReasoningNone`). Directive `on` → keep server profile effort/budget.

**Runner additions**: prompt body `reasoningMode: "fast"|"reasoning"` (optional); stdin config `provider.sendModelField: bool` (default false) → chat bodies include `"model": provider.model_id`.

**Desktop additions**: `RawSettings.reasoningMode` ("fast"|"reasoning", default "reasoning"); `DesktopStartupSettings.reasoningMode`; IPC `setReasoningMode` → `umbratic:set-reasoning-mode` and `listServerModels` → `umbratic:list-server-models` (`ServerModelInfo = {id, display, contextLength?, reasoning, available, default}`). Server model choice persists via existing `saveModelEndpointSettings({mode:"server", modelId})`; `"veil-managed"` remains the stored sentinel meaning "server default" (never sent on the wire).

---

## Phase 1 — Veil (Go, `infrastructure/veil`) — everything depends on this

1. **Config** (`internal/config/config.go` `Load()` :71-231): `ModelEntry` struct + `Config.Models []ModelEntry` + `Config.ModelSelectionEnabled`; parse/validate `VEIL_MODELS` (dupes, bad URLs, local-mode rejection, `VEIL_MODEL` membership); synthesize single entry when unset.
2. **Registry** (new `internal/model/registry.go`): one `Client` per entry (endpoints stay frozen per client); implements the `ModelClient` interface (server.go:27-36) routing by model id with default fallback; built in `cmd/veil/main.go` instead of bare `NewClient`. Extend `ModelClient` with `Available(ctx, id)` (runtime lists the id) and `ThinkingSupported(ctx, id)` (local: `api/show` capabilities, cached in `sync.Map`, probe failure → false; server: registry entry `reasoning`). Ripples into `fakes_test.go` — compile-driven.
3. **ChatRequest + bodies** (`internal/model/model.go`): add `Thinking *bool` to `ChatRequest` (:24-42); `doOllamaChat` (:482-507) emits `think` per the mapping above; `doVLLMChat` (:452-480) emits `chat_template_kwargs`; new `ollamaCapabilitiesFromPayload` next to :865-884. **Landmine: `prefix_tokens.go` cache key must gain the model id** — two models tokenize the same prefix differently.
4. **Policy** (`internal/policy/request.go`): `ChatInput` + `chatRequest` gain `Model`/`Thinking`; `DecodeChatInput` gains `allowedModels []string` (empty → keep today's loud `model` rejection at :219-224; `system` stays rejected always); add `"model"`, `"thinking"` to the `stripUnknownFields` allowlist (:224); normalize `thinking` tolerantly.
5. **HTTP** (`internal/http/`): `chat.go` resolves the chosen entry's client, maps `thinking` → `req.Thinking` (+ effort/budget suppression on "off"), uses the entry's `context_length` for preflight when set; new `models.go` handler for `GET /api/models` (bounded parallel availability probes, ~5s cache); `server.go` wires the route near `/api/health`; `handleHealth` `capabilities.reasoning` = local `ThinkingSupported(DefaultModel)`, server default-entry `reasoning || cfg.ModelReasoning`; `handleModelContext` accepts optional `?model=<id>`; `features.go` adds the three names.
6. **Golden fixtures** (`internal/policy/future_harness_test.go`): `thinking`+unknown fields pass on a no-registry server; `model`+`thinking` pass on a registry server; `model` still rejected on a no-registry server.

## Phase 2 — Runner (Rust, `packages/runner`)

- `config.rs`: `ProviderConfig.send_model_field` (JSON `sendModelField`, absent → false).
- `veil_client.rs`: `enum ThinkingDirective { On, Off }`; `VeilRequestOptions.thinking: Option<ThinkingDirective>`; body build (:801-815) inserts `"thinking"` when Some and `"model"` when `send_model_field`.
- `server.rs` prompt handler: parse optional `reasoningMode` → directive; `loop_runtime.rs` `run_turn` threads it into all `VeilRequestOptions` sites (:403, :425, :632, :660 + `final_without_tools`). Orient/compaction untouched.
- Tests: cargo body-construction matrix; `tests/native-runner-provider.ts` fake Veil asserts `thinking`/`model` presence when configured, absence by default; RAW_REASONING_MARKER leak assertions (:413, :550) stay green. Run both `cargo test --locked --package umbratic-runner --all-targets` and `npm --workspace @umbratic/runner run test:all` (TS tests are not in cargo).

## Phase 3 — Desktop main (`apps/desktop/src/main`)

1. **Persist toggle** (`settingsStorage.ts`): `RawSettings.reasoningMode`; `readReasoningModeSetting`/`writeReasoningModeSetting` (mirror permissionMode :391-418); include in `readStartupSettings` (:395-408). IPC `setReasoningMode` (desktopApi channel map :686-766, preload, main.ts handler mirroring `setPermissionMode` :396).
2. **Server model list**: new `serverModels.ts` — `fetchServerModels(provider)` GETs `/api/models` via `providerClient`, tolerant parse, gated on `models.list`. IPC `listServerModels`.
3. **Selection plumbing**: `settingsStorage.ts` server branch stores/returns real `modelId` (sentinel `"veil-managed"` = default, kept in `config.ts:22`); `endpointConfig.ts` `configuredEndpointModel()` uses it; **`endpointModeStorage.ts` untouched** (modelId is already one of the exact 5 keys). `backendSettings.ts` `resolveSelectedModel()` server branch: with `models.list`, build the model list from `/api/models` (selected = configured id → `default` entry → today's synthetic fallback).
4. **Runner spawn + prompt**: `runnerAdapter.ts` sets `provider.sendModelField = mode==="server" && feature && modelId!=="veil-managed"`; `policy.ts` adds the matching assertion after :502; `taskRunner.ts` prompt body adds `reasoningMode` when `mode==="local" || chat.thinking_toggle` (features are fresh — `resolveSelectedModel` runs at :181 every run); same param threaded into `submitSteeredRunnerTurn` (`backendSettings.ts:127-150`).

## Phase 4 — Desktop renderer (`apps/desktop/src/renderer`) — all new UI in NEW files

### 4.1 Files
- `ComposerModelControls.tsx`: exports `ThinkingToggle` + `ComposerModelPicker`; new stylesheet `styles/model-controls.css` imported from `styles.css`.
- Generalize `LocalModelPicker.tsx` into a reusable combobox (items + status + availability props) shared by the connection page's local and server pickers.
- `main.tsx` diff budget ≈ +10 lines: replace :1880 with `useState<ReasoningMode>(startupSettings.reasoningMode)` + persist callback, mount the two components inside `.promptControls` (:5464). Update `defaultStartupSettings` fallback and `previewEnvironment.ts` fixtures. If `scripts/check-source-size.ts` (baseline 6,520, currently failing at 6,668) still trips, move the workspace-mode menu block into the new component file in the same PR.

### 4.2 Exact UI spec — composer controls
Both sit in the `.promptControls` row between the permission control and the attach button, matching the 28px pill grammar (`composer-controls.css:381-427`):

**Think toggle** (`.thinkControl` / `.thinkToggle`):
- Pill button, height 28px, padding 0 9px, radius 999px, `Brain` icon (lucide, 14px) + label "Think", font 12px/500.
- Off: `border: 1px solid var(--line); background: var(--control-bg); color: var(--muted)` — identical to `.workspaceModeTrigger`.
- On: reasoning tokens — `color: var(--reasoning-text); border-color: var(--reasoning-border); background: color-mix(in srgb, var(--reasoning-border) 18%, var(--control-bg))`; hover deepens via `--reasoning-hover-*`.
- `aria-pressed`; `title` = "Thinking forced on — model reasons before answering" / "Thinking off — model answers directly".
- **Feedback on press, not release**: `:active { transform: scale(0.97); }`, `transition: transform 100ms ease-out` alongside the existing 150ms color transitions. No bounce — this is a tap, not a flick.
- Disabled (opacity .5) with explanatory `title` when the selected model lacks `capabilities.reasoning`; hidden in server mode without `chat.thinking_toggle`.

**Model picker** (`.modelControl` / `.modelTrigger` / `.modelMenu`):
- Trigger: same pill; `Cpu` icon (14px) + model display name (ellipsis, `max-width: 16ch`) + `ChevronDown` (12px).
- Menu opens **upward** like `.workspaceModeMenu`: `bottom: calc(100% + 7px); min-width: 240px; padding: 5px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--modal-bg); box-shadow: 0 18px 42px var(--shadow-color); animation: menuRise 180ms ease both; transform-origin: bottom left` (menu visibly grows from its trigger — anchored origin).
- Rows: `role="menuitemradio"` + `aria-checked`; name left, context badge right ("96k", `var(--faint)`, 11px), `Check` (14px) on selected. Keyboard nav from the shared combobox.
- Server rows: 6px status dot — `var(--green)` available, `var(--muted)` stopped; stopped rows opacity .55, still selectable (send tooltip explains the model isn't running).
- Local lists the probed Ollama models (cache + refresh); server lists `listServerModels` (refetch on open); hidden in server mode without `models.list`.
- Disabled with `title` "Wait for the current run to finish" while a run is active (main-process guard throws anyway; surface its message on failure). Selection calls `saveModelEndpointSettings` for the current mode, then refreshes `BackendStatus` so label, context meter, and Think gating update together.
- Reduced motion: `@media (prefers-reduced-motion: reduce)` swaps `menuRise` for a 120ms opacity fade (same pattern as `settings.css:692-706`).

### 4.3 Connection page (`ConnectionSettings.tsx`)
- Server mode: replace the static "veil-managed" with the shared model picker fed by `api.listServerModels`, plus a refresh affordance mirroring the local one; keep URL + enrollment + "Save & connect" unchanged. Feature absent → muted 12px "Model list unavailable on this server".

## Phase 5 — Veil Console (Go, `infrastructure/veil-console`)

1. **Startup**: new `--vllm-binary` option → `Startup.VLLMBinary`, validated like `VeilBinary` (config.go:87-108), optional — Models page renders a "not configured" state without it.
2. **State**: forward-only named migration `managed_models` (migrate.go ledger): `id PK, display_name, model_path, port UNIQUE, max_model_len, gpu_memory_utilization REAL, kv_cache_dtype DEFAULT 'fp8' CHECK IN ('fp8','auto'), reasoning INT, created_at`. CRUD in `state.go`.
3. **Typed config** (`internal/config`): `ManagedModel` struct + `Validate()` — id `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (no leading `-`), model_path 1-512 chars no control chars no leading `-`, port 1024-65535 unique and ≠ console/Veil ports, max_model_len 1024-1,048,576, gpu fraction (0,1], dtype ∈ {fp8, auto}. `ModelsEnvJSON()` builds `VEIL_MODELS` with `provider_base_url = http://127.0.0.1:<port>/v1`.
4. **Model supervisor** (new `internal/supervisor/models.go`): per-model `exec.Command` (no shell) with argv from a single pure `vllmArgs(m)` function — `serve <model_path> --host 127.0.0.1 --port <port> --served-model-name <id> --max-model-len <n> --gpu-memory-utilization <f> --kv-cache-dtype <fp8|auto>`; minimal allowlisted child env (PATH/HOME/CUDA/HF vars — never inherit wholesale); stdout/stderr into the existing `safeBuffer` ring (supervisor.go:342-401); **async start**: spawn, return immediately, background goroutine polls `GET 127.0.0.1:<port>/v1/models` (2s interval, ~10 min budget) flipping `starting → healthy | failed` (model loads take minutes — a blocking handler would time out the browser). Graceful `Stop` (requestProcessStop + kill deadline, like supervisor.go:180-209), `Status`, `Logs`, `StopAll` wired into console shutdown (reap children — no orphaned GPU processes). Per-model ops serialized; `ErrBusy` → 409.
5. **Veil handoff**: `SetModels(entries)` mirroring `SetRAG` (supervisor.go:67-71); `startLocked` appends `VEIL_MODELS=` when entries exist; web layer calls `SetModels` from stored rows before every Veil start/restart/apply. **Model start/stop does NOT restart Veil** — availability is live via `/api/models`; only add/edit/remove/default changes go through the existing Apply flow. Settings validates `VEIL_MODEL` ∈ managed ids when any exist.
6. **Web** (`internal/web`): routes `GET /models`, `POST /models/create`, `POST /models/{id}/update|delete|start|stop` — session + CSRF + `freshPassword` owner re-confirm on every POST (pattern :591-603), audit events `model.*`, `actionResult` redirect/error pattern. Page data includes per-model status, log excerpt, a "Restart Veil to apply model list changes" notice when stored set ≠ running Veil's env, and a non-blocking warning when Σ gpu fractions > 1.0 (legitimate on multi-GPU).

### 5.1 Console UI — exact spec
Server-rendered `templates/models.html` + `assets/models.css` (strict CSP — no inline style/script), dark tokens from `style.css:1-28`, cards at `--radius: 16px`:
- **Nav**: "Models" link between Dashboard and Settings in the shared header.
- **Page**: title row "Models" + primary "Add model" button (existing `.button`) right-aligned; one card per model, single column, 12px gap.
- **Model card**: left — display name (15px/600) with `id` beneath in mono 12px `var(--muted)`; middle — meta chips (12px `var(--surface)` pills): port, `max len 32k`, `GPU 0.45`, `KV fp8`, `reasoning`; right — status + actions. Status: 8px dot + label — healthy `var(--green)`, starting `var(--blue)` with gentle 1.6s opacity pulse (removed under `prefers-reduced-motion`), failed `var(--red)`, stopped `var(--muted)`. Actions: Start (primary) / Stop (`.button.danger`) behind password re-confirm; Edit; Remove (danger, only when stopped). "Logs" disclosure renders the ring-buffer tail in a `<pre>` server-side on expand — no websockets.
- **Add/Edit form** (own page, like settings): typed fields only — Display name; Model (HF id or absolute path); Served id (auto-suggested slug); Port (auto-suggest next free 8001-8099); Max model length; GPU memory fraction (0.05-0.95 step 0.05, helper line showing the sum across models, warning past 1.0); KV cache dtype select (**fp8 default — the 8-bit "q8"**, or auto); "Model emits thinking" checkbox. Inline validation in the existing form-error style.
- **Dashboard**: compact "Models — N running / M registered" line linking to /models. **Settings**: model dropdown becomes "Default model" sourced from managed models (generation probe button stays).

## Phase 6 — Docs

- `infrastructure/veil-console/AGENTS.md` (:13) + README: document the deliberate exception — purpose-built typed vLLM launcher, argv assembled server-side exclusively from validated typed fields, free-form arguments remain forbidden; document `--vllm-binary` and `managed_models`.
- `infrastructure/veil/README.md`: `VEIL_MODELS` docs; fp8 KV cache = the 8-bit option; keep the "no `--api-key`" rule; note `OLLAMA_KV_CACHE_TYPE=q8_0` for local admins.
- Root/desktop AGENTS "Veil boundary": user model selection among the Veil-published registry is a product route choice, not a runtime decision.

## Ordering

Phase 1 first → Phases 2 + 3 in parallel → Phase 4 after 3. Phase 5 depends only on Phase 1's env contract (parallel with 2-4). Local-mode thinking ships after 1+2+3+4 with zero console work.

## Test plan

- **Veil** (`go test -race ./...`): policy model accept/reject matrix + `thinking` normalization; the three golden fixtures; `model_test.go` Ollama `think` matrix (directive × capability), vLLM `chat_template_kwargs` + effort omission on "off", capabilities parse, **prefix-cache key includes model id**; config `VEIL_MODELS` parse/validate; `/api/models` handler (auth/shape/availability); features list in both registry states; per-model chat routing; `?model=` context param.
- **Runner**: cargo body matrix + config parse; TS fake-provider assertions (presence when configured, absence by default, reasoning-leak checks unchanged).
- **Desktop** (vitest): `preload-ipc` (2 new pairs), ipc-registry, startup-settings seeding, storage round-trip (reasoningMode + server modelId sentinel), runner-adapter `sendModelField` truth table, policy assertion, new `main-server-models` and `renderer-composer-model-controls` tests, no-versioning guard green, `check-source-size` not worse than baseline.
- **Console** (`go test -race ./...`): migration idempotency + CRUD; `vllmArgs` table test incl. injection attempts (leading `-`, whitespace, control chars); start/stop lifecycle with a stub binary; `SetModels` env bytes; route auth/CSRF/password-confirm; audit rows.
- Root: `npm run test:all`, `npm run supply-chain:check`.

## Verification (end-to-end)

1. **Local**: dev app (or the headless live probe) with a thinking-capable Ollama model — Think off → Veil debug/capture shows `think:false` on `/api/chat`; on → `think:true`; non-thinking model → no `think` field and toggle disabled; relaunch → toggle restored from SQLite; switch local model from the composer → local Veil restarts on the new model.
2. **Server**: console + two fake runtimes; register two models, Start both (async status reaches healthy); `GET /api/models` lists both available; app composer picker shows both; switching sends the chosen `model` per request (assert in fake runtime); stop one → picker dims it; old-Veil simulation (feature-stripped health) → server picker and toggle hidden, wire bytes identical to today.
3. Full suites per the test plan.

## Risks / landmines

1. `main.tsx` size gate already failing (6,668 vs 6,520) — all UI in new files, mount lines only, fall back to extracting the workspace-mode menu.
2. `endpointModeStorage.ts:15-28` exact-5-key validator — this plan adds no stored-endpoint keys.
3. `ModelClient` interface growth ripples into `fakes_test.go` and warm-up paths — compile-driven, budget for it.
4. Prefix-token cache currently keyed without model id — wrong counts under per-request models unless fixed (Phase 1.3).
5. Ollama `think` on non-thinking models errors on some versions — send only when `api/show` confirms; probe failure = unsupported.
6. vLLM `chat_template_kwargs.enable_thinking` only affects templates that read it (Qwen3-family); send only on explicit directive; document per-model expectations in the console README.
7. `reasoning_effort` suppression must happen in `handleChat`, not `doVLLMChat` (its guard only skips `ReasoningNone`).
8. Loud `model` rejection must stay byte-identical when no registry — encoded in golden fixtures.
9. Console must `StopAll`/reap on shutdown — no orphaned GPU processes; dev is Windows, prod Ubuntu (`configureProcess`/`requestProcessStop` abstractions — extend, don't fork).
10. vLLM start latency is minutes — async start with status polling; blocking would time out the browser and trip the busy lock.
11. Feature freshness: gating reads features recorded by the last health check — safe because `resolveSelectedModel()` runs at the top of every task; the active-run guard on `saveModelEndpointSettings` prevents mid-run switches.
12. Root AGENTS rule "desktop and runner never call runtimes directly" holds: server model list flows only through Veil `/api/models`; the console's vLLM polling targets its own supervised children.
