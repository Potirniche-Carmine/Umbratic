# Accurate Context Counter for Umbratic

Replace Umbratic's heuristic context meter with the **usage-anchored** model used by pi, Hermes, OpenCode, Codex CLI, Cline, and Claude Code: the provider-reported usage of the last completed response is, by definition, the *exact* size of the settled context — no tokenizer required — and only the un-sent tail (new draft, queued tool results) is estimated until the next response replaces the estimate with a measurement. Add a click-through breakdown (system prompt / tool definitions / skills / conversation / tool results) following the same convention every one of those harnesses uses: **measured headline, estimated-by-category rows** — and upgrade compaction to trigger and self-verify on the same measured numbers (see [Compaction](#compaction)).

## Research: how the accurate harnesses actually do it

None of the harnesses with "accurate" context meters run a local tokenizer for the meter. They all exploit the same identity:

> **True current context = the last response's prompt-side usage (which already includes system prompt + tools + full history) + that response's output tokens (since the assistant turn will be resent).**

| Harness | Meter source | Un-sent tail | Per-category breakdown |
|---|---|---|---|
| **pi** (badlogic/pi-mono) | Last valid assistant message's `Usage.totalTokens` (input + output + cacheRead + cacheWrite), normalized per provider | chars/4 estimate appended on top of the anchor; anchor disqualified by a timestamp guard if the prefix was mutated | none |
| **Hermes** (NousResearch/hermes-agent) | `last_prompt_tokens` from response usage; explicit "awaiting real usage" sentinel after compression | chars/4 (+CJK-aware) preflight estimator, documented as "pre-flight only" | yes — `/context` table titled **"Estimated usage by category"**, chars/4 over the actually-assembled parts; headline overridden by measured total |
| **OpenCode** (sst/opencode) | Last assistant message's `input + output + reasoning + cache.read + cache.write` / model limit | not counted until next response | none |
| **Codex CLI** (openai/codex) | `last_token_usage.total_tokens` from a `TokenCountEvent` per response | **estimate-then-replace**: `set_estimated_prefill()` later swapped by `ensure_server_observed_prefill_from_usage()` | none (fixed 12K baseline constant for system+tools) |
| **Cline** | Last request's `tokensIn + tokensOut + cacheWrites + cacheReads` | invisible to gauge; chars/3 estimator (deliberately over-counts) only for compaction triggers | none |
| **Aider** | local litellm tokenizer (the one true tokenizer-based outlier; accuracy depends on tokenizer mapping) | n/a (all local) | yes, tokenizer-counted |
| **Claude Code** | last transcript entry's `input + cache_creation + cache_read` (usage persisted per assistant message in session JSONL) | — | yes — `/context` section literally titled "Estimated usage by category" |

Design details worth stealing:

1. **pi's anchor guard** — the anchor usage is only valid if nothing *before* it in the message array changed after it was recorded (compaction splices a summary into the prefix → anchor disqualified). Right after compaction pi displays `?/200k` instead of guessing.
2. **Codex's estimate-then-replace** — a locally estimated number is explicitly a placeholder state that the next server-observed usage overwrites; the two are never blended.
3. **Cline's scale-free ratio** — when a compaction postdates the last measured request, the gauge is rescaled by the compaction's `after/before` ratio (both sides from the same estimator) instead of substituting an estimate for a measurement, so the bar doesn't visibly re-snap when real usage lands.
4. **Hermes/Claude Code's breakdown convention** — per-category rows are estimates over the *actual* assembled strings/schemas, and are labeled as estimates; only the headline total is measured. Nobody makes per-category round-trips to a count-tokens endpoint.

## Where Umbratic stands today

The pieces mostly exist; they're just not anchored.

**Already in place:**

- Veil requests usage from vLLM (`stream_options.include_usage`, [`model.go:363-366`](../infrastructure/veil/internal/model/model.go)) and synthesizes OpenAI-shaped usage for Ollama ([`model.go:578-590`](../infrastructure/veil/internal/model/model.go)).
- The runner captures `prompt_tokens` / `completion_tokens` in [`veil_client.rs:522-542`](../packages/runner/src/veil_client.rs) (`update_usage` → `VeilChatResult`) and already emits `phase:"observed", source:"provider", confidence:"high"` `context.usage` events ([`loop_runtime.rs:250-268`](../packages/runner/src/loop_runtime.rs)).
- The desktop threshold/telemetry paths already trust only provider-observed events ([`mainRuntime.ts:568-596`](../apps/desktop/src/main/mainRuntime.ts), [`telemetry.ts:331`](../apps/desktop/src/main/telemetry.ts)).
- The meter already merges a runner-measured base with a locally estimated draft delta ([`main.tsx:2276-2322`](../apps/desktop/src/renderer/main.tsx), [`contextWindow.ts:166-219`](../apps/desktop/src/shared/contextWindow.ts)).

**Why the meter is still an estimate:**

1. **Preflight ignores the last measurement.** `estimate_context_usage` ([`context.rs:634-661`](../packages/runner/src/context.rs)) re-estimates the *entire* history at bytes/3 every turn; observed usage only feeds a calibration multiplier clamped to 1.0–1.5× ([`context.rs:580`](../packages/runner/src/context.rs)) that can inflate but never correct an overshoot, and is discarded whenever the profile fingerprint changes.
2. **The system prompt is invisible.** Veil owns and prepends it ([`prompts.go:69-88`](../infrastructure/veil/internal/prompts/prompts.go)); the runner strips system messages ([`veil_client.rs:658-664`](../packages/runner/src/veil_client.rs)) and substitutes a flat `protected_prompt_reserve_tokens = 2048` constant.
3. **Three inconsistent estimators** — runner preflight bytes/3, runner compaction/state budgets bytes/4 ([`compaction.rs:158-159`](../packages/runner/src/compaction.rs)), desktop chars/4 + nonAsciiBytes/2 ([`contextWindow.ts:67-79`](../apps/desktop/src/shared/contextWindow.ts)).
4. **The UI can't receive anything richer.** The adapter silently drops any `context.usage` where `promptTokens !== contentTokens` ([`runnerEventAdapter.ts:447-452`](../apps/desktop/src/main/runnerEventAdapter.ts)); the contract hard-codes `estimatedTokens === contentTokens + reserveTokens` and `promptTokens === contentTokens` ([`backendEvents.ts:168-176`](../apps/desktop/src/shared/backendEvents.ts)); the decoder omits `protectedTokens`/`estimatedTokens` ([`runnerEventDecoder.ts:51-61`](../apps/desktop/src/main/runnerEventDecoder.ts)); the meter copy hard-codes "Estimated" ([`main.tsx:860,886`](../apps/desktop/src/renderer/main.tsx)).

## Design

Three decisions, each the lowest-change option that matches the harness consensus:

**D1 — Usage anchor + trailing delta (runner).** After every successful Veil response, record a `UsageAnchor { prompt_tokens, completion_tokens, anchor_len }` on the `Session`, where `anchor_len` is `messages.len()` at the moment the assistant turn (and its tool calls) have been appended. The current context is then:

```
context_tokens = anchor.prompt_tokens + anchor.completion_tokens
              + estimate_json_array_tokens(messages[anchor_len..])   // un-sent tail only
```

The bytes/3 heuristic keeps covering exactly two cases: the tail, and the whole prompt when no anchor exists (fresh session, or seeded from `ConversationState`, which already persists `observed_prompt_tokens`). This is pi's model verbatim, using machinery Umbratic already has.

**Anchor invalidation (pi's guard):** any mutation of `messages[..anchor_len]` clears the anchor — semantic compaction ([`compaction.rs:287-416`](../packages/runner/src/compaction.rs)), `compact_oldest_tool_exchange`, and seeding all qualify. While unanchored, events are emitted with `source:"heuristic", confidence:"low"` — which the desktop already treats as non-authoritative — and the UI shows a "recalculating" state instead of a confident number. The next observed usage re-anchors. The calibration multiplier stays untouched as the fresh-session/unanchored fallback; once anchored it is simply never consulted (optional later cleanup: delete it — not part of this plan).

**D2 — Veil reports the system prompt size.** The only category the runner cannot measure. Veil computes the token count of the fully assembled protected prefix (global + route + skill-catalog prompt from `prompts.Build`) via the runtime's tokenizer — vLLM exposes `POST /tokenize` — **cached per (route, skill-catalog hash)**, so it costs one tokenize call per route per catalog version, not per request. For Ollama (no stable tokenize endpoint) fall back to chars/4 and flag it. Veil already rewrites every SSE frame it forwards ([`safe_stream.go`](../infrastructure/veil/internal/model/safe_stream.go)), so it injects one extra field into the final usage object:

```json
"usage": { "prompt_tokens": 41230, "completion_tokens": 512, "total_tokens": 41742,
           "system_prompt_tokens": 3187, "system_prompt_tokens_exact": true }
```

`update_usage` picks it up; the runner replaces the 2048-token `protected_prompt_reserve_tokens` stand-in with the real number for all subsequent preflights in the session (a strict accuracy improvement even before the UI work lands). If Phase 2 ships late or the field is absent, everything below still works — the system-prompt row just shows "reserved (estimated)" as today.

**D3 — Breakdown: measured headline, estimated rows (Hermes/Claude Code convention).** Computed runner-side at request assembly, where every category is already a distinct value ([`veil_client.rs:689-703`](../packages/runner/src/veil_client.rs)): `messages` split into conversation vs `role:"tool"` results, `tools`, `skills`, plus image count. Rows use the existing bytes/3 estimator over the actual payloads; the system-prompt row uses the Veil-reported number; the headline total is the anchored measurement. **The rows are not reconciled to sum to the headline** — that's the accepted convention everywhere ("Estimated usage by category"), and forcing reconciliation would smear estimator error across categories. No per-request count-tokens round-trips.

Explicitly rejected alternatives: local tokenizer (wrong tokenizer for the runtime model, new heavy dependency — the mistake the Anthropic docs warn about with tiktoken-for-Claude); per-category tokenize calls to Veil (N round-trips per turn for rows nobody needs to be exact); deriving system-prompt size as `observed − estimated payload` (absorbs the entire estimator error into one row).

## Compaction

Accurate counting and compaction are one system: the counter decides *when* to compact, and compaction is the event that invalidates the counter. The same research pass covered how each harness compacts.

### Research: compaction across the harnesses

| Harness | Trigger | Cheap tier before LLM summarization | Summary validation | Counter recovery after compaction |
|---|---|---|---|---|
| **pi** | `contextTokens > window − 16 384`; keep newest ~20k tokens verbatim, cut only at non-tool-result boundaries | none | none (failed compaction aborts, session untouched) | reload; wait for next real usage |
| **Codex CLI** | 90% of window, checked pre-turn and mid-turn | replaces old tool outputs with `"Output exceeded…truncated"` newest→oldest until it fits | exactly-one-summary-item check; retries on a fallback model | per-window "prefill baseline" reset from next server-observed usage |
| **Hermes** | 50% (≥75% for <512k windows) of `window − max_output` | 4-pass deterministic prune: dedup identical tool results → demote old results to one-liners → truncate args >500 chars → pressure-demote inside the tail; commit only if reclaim ≥ 4 096 tokens (cache-break amortization) | **verdict rendered on the next real `prompt_tokens`**: still ≥ threshold ⇒ "ineffectiveness strike"; 2 strikes ⇒ auto-compaction breaker trips (incompressible system-prompt+tools floor) | `awaiting_real_usage` sentinel parks the counter and defers preflight re-triggering for one turn |
| **Claude Code** | ~`window − output_reserve − 13k` | "microcompaction": old tool results → `[Old tool result content cleared]`, hot tail stays inline | pauses auto-compact after 3 consecutive failures | next API usage re-anchors |
| **Cline** | 90%, target 70% | — | **strongest acceptance bar**: overflow-recovery result must be non-empty, strictly smaller, and ≤ target; overflow recovery deliberately never depends on another LLM call | ratio-rescales the displayed gauge (scale-free) until real usage lands |
| **OpenCode** | `tokens ≥ usable − min(20k, max_output)` | `prune()`: drop tool outputs older than the newest 40k tokens' worth, skip 2 newest user turns and skill outputs; commit only if reclaim > 20k | non-empty summary + summarization request itself must fit | hides compacted pairs from next request; next usage re-anchors |

Cross-cutting: a **deterministic tool-output prune tier before LLM summarization is near-universal** (4 of 6); **tool-pair atomicity** in cut points is universal; **iterative previous-summary update** is the majority design (pi, Hermes, Cline, OpenCode); only Hermes and Cline actually **verify compaction worked**, and Hermes is the only one that verifies against *measured* tokens — everyone else trusts the summarizer and can loop.

### Where Umbratic already stands

Stronger than most of the field, notably:

- Tool-batch-atomic cut points (`safe_cut_point`, tool-group accounting in `fitted_compaction_end`, [`compaction.rs:126-208`](../packages/runner/src/compaction.rs)) — matches the universal rule.
- Iterative summaries via `durable_summary`, a six-heading contract validated in order (`valid_semantic_summary`, [`compaction.rs:269-285`](../packages/runner/src/compaction.rs)), and a genuine shrink-acceptance check (projected must beat current and reach the 55% target, [`compaction.rs:393-410`](../packages/runner/src/compaction.rs)) — only Cline has an equivalent bar.
- A protected tail (latest user turn + budget) and a keyword-based "anchor carrier" preserving failure/edit/verification evidence ([`compaction.rs:210-258`](../packages/runner/src/compaction.rs)).
- A deterministic fallback (`compact_oldest_tool_exchange`) and a `failed_compaction_digest` guard against retrying a known-bad prefix.

The real gaps are exactly where the counter work intersects:

1. **The 80% trigger fires on the bytes/3 estimate**, so it fires at the wrong real fullness — the whole point of Phase 1.
2. **Nothing prevents post-compaction double-fires.** After a compaction the estimate is heuristic again; a pessimistic estimate can re-trigger before the next response proves the real (smaller) size — the exact bug Hermes's sentinel exists for.
3. **Effectiveness is judged estimate-vs-estimate.** Scale-free and safe (Cline's ratio argument), but the *binding* verdict should be the next measured `prompt_tokens` — if compaction can't get below the trigger because system prompt + tools are the floor, Umbratic will loop semantic compactions that cannot succeed.
4. **The deterministic tier only folds the single oldest tool exchange, as a last resort.** The field consensus is the opposite order: bulk-prune stale tool outputs cheaply *first*, summarize only if still needed.

### Compaction decisions

**C1 — Trigger and verdict on measured tokens.** Free once Phase 1 lands: `prepared_messages` reads `request_estimate`, which becomes anchor-accurate. Add the Hermes verdict: after a semantic compaction, compare the *next observed* `prompt_tokens` against the semantic trigger; still above ⇒ record an ineffectiveness strike; **two strikes ⇒ stop auto-triggering semantic compaction for the session** (surface a `context.usage` event with a `compactionBlocked: true` flag so the UI can say "context is at its incompressible floor" instead of silently thrashing). `failed_compaction_digest` already covers the identical-prefix case; the strike counter covers the succeeded-but-didn't-help case.

**C2 — Post-compaction sentinel.** When compaction (semantic or tool-exchange) clears the usage anchor (D1), also set a one-turn `awaiting_observed_usage` flag: while set, heuristic estimates may not re-trigger semantic compaction (hard overflow errors still can). Cleared by the next observed usage. This is Hermes's sentinel and pi's "?" state expressed in Umbratic's existing `phase`/`confidence` vocabulary.

**C3 — Deterministic prune tier runs first.** Generalize `compact_oldest_tool_exchange` from "fold one exchange when nothing else fits" into a pre-pass at the semantic trigger: demote `role:"tool"` results *outside the protected tail* to bounded one-line summaries (the existing `append_compacted_summary` machinery, oldest-first), stopping once below trigger or out of candidates; only then attempt semantic compaction. Commit the prune only if projected reclaim ≥ **4 096 tokens** — vLLM prefix caching means every prefix rewrite is a cache break, so small reclaims cost more than they save (Hermes and OpenCode both gate on exactly this reasoning). Tool-pair atomicity is preserved by the existing group logic.

**C4 — Deterministic file tracking in the summary.** pi appends machine-extracted `<read-files>` / `<modified-files>` lists to every summary; Claude Code goes further and re-reads recent files. Adopt pi's version: the runner extracts paths from its own tool calls (`read`, `write`, `edit`, `search` targets) in the compacted prefix and appends them to the summary sent to Veil as two fixed lists the summarizer must carry through — deterministic, ~zero tokens of overhead, and it hardens the keyword-based anchor carrier with ground truth.

Rejected: pi's split-turn double-summary (complexity; Umbratic's protected-tail rule already refuses to cut mid-turn); Claude Code's automatic file re-read (up to ~50k tokens re-injected — a separate feature decision, not a counter/compaction fix); Codex remote-v2 opaque compaction items (requires a model trained for it); Hermes's micro-compaction rolling summary (even Hermes ships it off by default — the cache-break-per-turn cost is real).

### Phase 5 — Compaction upgrades (Rust, `packages/runner`; after Phases 1–3)

1. **`session.rs`** — add `awaiting_observed_usage: AtomicBool` and `compaction_strikes: AtomicU32` beside `compaction_count`.
2. **`loop_runtime.rs`** — `prepared_messages`: skip the semantic trigger while `awaiting_observed_usage` is set; insert the C3 prune pass (with the 4 096-token reclaim gate) before `attempt_semantic_compaction`; on the first observed usage after a compaction, render the C1 verdict and clear the sentinel.
3. **`compaction.rs`** — extend `compaction_source` with the C4 file-list carrier (a second deterministic carrier message beside `semantic_anchor_carrier`); generalize the tool-exchange folding loop for C3.
4. **Events** — `context.usage` gains optional `compactionBlocked?: boolean`; the desktop meter popover shows the incompressible-floor notice. (One optional field; same back-compat rule as Phase 3.)
5. **Overflow posture (Cline's rule)** — the existing `context_overflow_*` retry paths must resolve using *deterministic* tiers only (prune + tool-exchange folding), never a Veil summarization call: when the provider has already rejected the request, recovery cannot depend on another LLM round-trip succeeding. Today's code already leans this way; make it an explicit invariant with a test.

## Implementation plan

Each phase is independently shippable and useful on its own. Phase 2 (Go) can land in parallel with Phase 1. Phase 5 (compaction upgrades) is specified in the [Compaction](#compaction) section and depends on Phase 1 only.

### Phase 1 — Anchor the runner (Rust, `packages/runner`)

1. **`session.rs`** — add `pub usage_anchor: Mutex<Option<UsageAnchor>>` to `Session` beside `context_calibration`.
2. **`loop_runtime.rs`** — where the assistant response is appended and `observed_context_event` fires (`:650-653`, `:439-443`): set the anchor from `VeilChatResult { prompt_tokens, completion_tokens }` + current `messages.len()`. Clear it in `prepared_messages` whenever semantic compaction or `compact_oldest_tool_exchange` mutates the prefix.
3. **`context.rs`** — teach `request_estimate` / `estimate_context_usage` to take the anchor: when present and `messages.len() >= anchor_len`, return `anchor_total + tail_estimate` with `source:"provider-anchored", confidence:"high"`; otherwise the existing heuristic path unchanged. Compaction triggers in `prepared_messages` and the semantic-compaction accept check (`:393-410`) automatically inherit the accurate number since they read `request_estimate`.
4. **`veil_client.rs`** — extend `VeilChatResult` and `update_usage` with `system_prompt_tokens: Option<u64>` / `system_prompt_tokens_exact: Option<bool>` (tolerant: absent fields keep today's behavior).
5. **`conversation_state.rs`** — `ConversationStateUsage` already persists `observed_prompt_tokens`; also persist `observed_completion_tokens` so a restored session can seed a low-confidence anchor instead of starting cold.
6. **`loop_runtime.rs` events** — extend `observed_context_usage` / `context_event` payloads with an optional `breakdown` object (below) and the real `protectedTokens` once Veil reports it (replacing the hardcoded `0`). Keep the existing invariant `estimatedTokens == contentTokens + reserveTokens` intact so old desktop builds keep working.

### Phase 2 — Veil system-prompt sizing (Go, `infrastructure/veil`)

1. **`internal/prompts`** — expose the fully assembled protected prefix for a (route, catalog) pair (it's what `Build` already produces).
2. **`internal/model/model.go`** — on first use per (route, skill-catalog hash): vLLM → `POST /tokenize` the assembled prefix, cache exact count; Ollama → chars/4, cache with `exact:false`. Inject `system_prompt_tokens` / `system_prompt_tokens_exact` into the final usage frame in both the vLLM sanitizer path (`safe_stream.go`) and the Ollama conversion (`model.go:578-590`).
3. Invalidate the cache entry when the skill catalog hash changes (the fingerprint input already exists on the runner side; Veil recomputes its own hash from `prompts.Build` inputs).

### Phase 3 — Event pipeline + UI (TypeScript, `apps/desktop`)

1. **`shared/backendEvents.ts`** — extend `context.usage` with optional fields; keep every existing invariant on the existing fields:

   ```ts
   breakdown?: {
     systemPromptTokens: number;  systemPromptExact: boolean;
     toolDefinitionTokens: number;
     skillTokens: number;
     conversationTokens: number;  // user + assistant messages
     toolResultTokens: number;    // role:"tool" messages
     imageTokens: number;
   };
   anchored?: boolean;            // true ⇒ contentTokens is measured, not estimated
   ```

   Validation for the new object: all fields non-negative integers when present; **no** requirement that rows sum to `contentTokens` (documented in the contract comment).
2. **`main/runnerEventDecoder.ts`** — add `breakdown`, `anchored`, and the currently-omitted `protectedTokens`/`estimatedTokens` to the type and validator.
3. **`main/runnerEventAdapter.ts`** — forward the new fields in `handleContextUsage`; the `promptTokens !== contentTokens` drop at `:447-452` stays (runner still emits them equal) but gets a comment pointing at the contract invariant so a future divergence fails loudly in tests rather than silently here.
4. **`renderer/main.tsx`** — three changes:
   - `runnerContextUsage` selection (`:2276-2282`) carries `breakdown`/`anchored` through.
   - `ContextMeter` (`:857-891`) becomes clickable → a popover: measured headline (`formatTokenCount(used) / formatTokenCount(contextLength)`, percentage ring as today), then "Estimated usage by category" rows — System prompt (marked *measured* when `systemPromptExact`), Tool definitions, Skills, Conversation, Tool results, Images, Draft & attachments (local estimate, existing composer path), Output reserve, Free space.
   - Meter label states replace the hardcoded "Estimated": **Measured** (`anchored`), **Estimated** (heuristic/preflight/fresh session), **Recalculating…** (a compaction event postdates the last anchored event — pi's `?` state; render the ring dimmed with the last known value rather than a fake-confident number).
5. **`shared/contextWindow.ts`** — unchanged math; `estimateContextUsage` keeps layering the draft delta on the runner base. Only addition: pass through `anchored`/`breakdown` so `ContextMeter` can render states.

### Phase 4 — Consistency cleanup (small, optional, separate PR)

- Align the two runner tail estimators (bytes/3 in `context.rs` vs bytes/4 in `compaction.rs:158-159` / `conversation_state.rs:318-324`) on bytes/3, keeping Cline's rationale: the preflight estimator should *over*-count so compaction fires before the provider rejects. Do **not** touch the desktop chars/4 draft estimator — it only sizes the un-sent draft delta, where precision is irrelevant by design.
- Optional: delete `ContextCalibration` once anchor coverage is proven in telemetry (it becomes dead weight for every turn after the first).

## Test plan

Extend the suites that already pin this behavior; no new frameworks, no e2e, no snapshot tests.

**Rust (`packages/runner`)**

| Test | Where | Asserts |
|---|---|---|
| Anchor arithmetic | `context.rs` tests | anchored estimate = `prompt + completion + bytes/3(tail)`; unanchored path byte-identical to today's `context_estimate_matches_veil_json_accounting…` (`:764-783`) |
| Anchor lifecycle | `loop_runtime_tests.rs` | response sets anchor; semantic compaction and `compact_oldest_tool_exchange` clear it; next observed usage re-anchors; while cleared, events say `source:"heuristic", confidence:"low"` |
| Event shape | extend `observed_usage_does_not_double_count…` (`loop_runtime_tests.rs:122-131`) | `breakdown` rows present and non-negative; `protectedTokens` = Veil-reported value when available, else `0`; `estimatedTokens == contentTokens + reserveTokens` still holds |
| Usage parsing | extend `total_only_usage_completes_a_partial_provider_measurement` (`veil_client.rs:885-902`) | `system_prompt_tokens` parsed when present, ignored when absent; partial/total-only frames still complete |
| Anchor seeding | `conversation_state.rs` tests | restored state with `observed_prompt_tokens` seeds a low-confidence anchor; without it, cold start |
| Compaction uses anchor | `loop_runtime_tests.rs` | with an anchor present, the semantic trigger fires off the anchored count, not the heuristic |
| Post-compaction sentinel | `loop_runtime_tests.rs` | after compaction, a pessimistic heuristic estimate does not re-trigger semantic compaction; the next observed usage clears the sentinel; overflow errors bypass it |
| Ineffectiveness breaker | `loop_runtime_tests.rs` | observed usage still above trigger after compaction ⇒ strike; two strikes ⇒ semantic auto-compaction stops and events carry `compactionBlocked: true`; a later observed drop below trigger resets the strikes |
| Prune tier | `compaction.rs` tests | prune demotes only tool results outside the protected tail, oldest first, keeps tool groups atomic (extends existing `safe_cut_point` tests), and is skipped entirely when projected reclaim < 4 096 tokens |
| File-list carrier | `compaction.rs` tests | read/modified paths extracted from tool calls in the prefix appear in the compaction source; no paths ⇒ no carrier message |
| Overflow is LLM-free | `loop_runtime_tests.rs` | `context_overflow_*` recovery resolves via prune/fold only — no `compact_context` Veil call on the recovery path |

**Go (`infrastructure/veil`)**

| Test | Where | Asserts |
|---|---|---|
| Usage injection | extend `model_test.go` vLLM (`:409`) + Ollama (`:533-534`) cases | final usage frame carries `system_prompt_tokens` (+ `_exact` true for vLLM path, false for Ollama) |
| Tokenize caching | new case in `model_test.go` | two requests on the same route ⇒ one `/tokenize` call; catalog-hash change ⇒ recount |

**TypeScript (`apps/desktop/tests`)**

| Test | Where | Asserts |
|---|---|---|
| Contract | `backend-events-contract.test.ts` | valid fixture with `breakdown`/`anchored` accepted; negative rows rejected; existing invariants (`:60-65`) unchanged and still enforced |
| Decoder | `main-runner-event-decoder.test.ts` | new fields decoded; events without them still valid (back-compat) |
| Adapter | adapter suite | `breakdown`/`anchored` forwarded intact through `handleContextUsage` |
| Meter states | `context-window.test.ts` | anchored event ⇒ "Measured"; heuristic ⇒ "Estimated"; compaction-after-anchor ⇒ "Recalculating"; draft delta still layers on the measured base (extend `:39-45`) |
| Thresholds | `main-telemetry.test.ts` | anchored events fire 75/90% thresholds exactly as `observed` events do today (`:376-379`) — i.e. no behavior change |
| Constants guard | `context-window.test.ts:9-17` | keep passing — the plan renames no Rust constants |

**Acceptance criteria**

1. After any completed assistant turn, the meter equals the runtime-reported usage exactly (verifiable against Veil's `prompt_tokens_total` metric and vLLM logs) — zero estimation error at every turn boundary.
2. Between turns, only the draft/attachment delta and un-sent tool results are estimated, and the label says so.
3. Immediately after compaction the UI shows "Recalculating…", never a confident wrong number; it re-anchors on the next response.
4. Clicking the meter shows the category table with the system-prompt row measured (vLLM) and the headline always measured when anchored.
5. A desktop build without Phase 3 keeps working against a Phase-1 runner (new event fields are optional), and vice versa.
6. Compaction fires off measured tokens, never double-fires while awaiting the next measurement, and stops auto-retrying (with a visible "incompressible floor" notice) once two measured verdicts prove it can't get below the trigger.
7. Provider-overflow recovery completes without any Veil summarization call.

## Non-goals

- **No local tokenizer** (tiktoken/HF) anywhere — wrong-tokenizer risk, heavy dependency, and the research shows nobody accurate needs one.
- **No per-request or per-category tokenize round-trips** — one cached tokenize per (route, catalog) is the ceiling.
- **No cache-token fields** (`cache_read/cache_creation`) — Veil/vLLM doesn't report them; the `Usage`-normalization designs from pi/OpenCode are documented here for when it does, but adding speculative fields now is dead code.
- **No unification of the desktop draft estimator** with the runner's — it sizes an un-sent draft, where a rough number is the correct tool.
- **No historical/cumulative token accounting UI** (session cost totals à la pi's `↑↓$` line) — separate feature, separate plan.
