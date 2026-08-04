# Umbratic Harness Reliability Plan

Status date: 2026-08-03. This revision replaces the pre-cutover plan. The lifecycle, skill, runtime-mode, and workspace-tool cutovers described by the old plan have landed and were verified against the code. This document records the contract that now exists, the defects that remain, and what must still land for the program to succeed.

## Goal

Make the harness deterministic and consistent so tasks settle to truthful state and expected outcomes.

Exact wording from the model may vary. The harness must not. Instructions, skills, tool definitions, validation, lifecycle events, evidence, and failure behavior must be the same every time for the same inputs.

Server mode is the priority: concurrent users and a high-throughput vLLM deployment without the harness becoming the bottleneck. Local mode must keep working through Ollama. Both modes go through Veil. The runner never calls a model runtime directly.

Reliability means expected outcomes and truthful lifecycle state, not identical model text.

## Fixed decisions

- Do not preserve backward compatibility. Producers and consumers change together. Delete legacy fields, aliases, parsers, migrations, dual writes, and fallback behavior.
- **No versioning, anywhere.** No schema version numbers, no wire-contract IDs, no version negotiation, no old-ID allowlists. A contract is defined by its exact shape. Every consumer rejects unknown fields, missing fields, and invalid values instead of guessing or adapting. Coordinated desktop and Veil releases cut over together; if mixed clients must be served, route them to a separate pinned old deployment. Do not reintroduce a `version`, `schemaVersion`, or contract-ID field in any internal payload.
- Server mode uses vLLM only. Local mode uses Ollama only. Veil Console does not offer a runtime selector. The desktop does not offer vLLM for app-managed local Veil.
- Veil owns protected prompts, generation settings, model capabilities, tool-call mode, and the final runtime request.
- The runner owns the agent loop, canonical workspace-tool contract, validation, policy, permissions, scheduling, execution, and lifecycle events.
- The desktop owns durable local product state and persists the runner's conversation state after each settled step.
- **Workspace checkpoint** means only the existing Git/worktree restore point. Conversation lifecycle state never uses that name and is never restored by a workspace-checkpoint action.
- Do not add a generic vLLM passthrough or expose provider details to the renderer.

## Target request path

```text
Server: Desktop -> local Runner -> hosted Veil -> private vLLM
Local:  Desktop -> local Runner -> local Veil  -> local Ollama
```

The Rust runner and workspace tools remain local in both modes. Server work moves model inference and model policy to hosted Veil and vLLM; it does not move workspace execution to the server.

## Agent-loop lifecycle (landed, normative)

### Definitions

- **Operation:** one exclusive session action, such as a run or compaction. A session has at most one active operation.
- **Run:** one user request plus any model/tool steps needed to settle it.
- **Step:** one complete assistant response and, when present, its complete tool-call batch and results.
- **Conversation state:** the validated bounded model history after a complete step. It never contains an incomplete assistant message, orphan tool result, or partial parallel batch.
- **Settled step:** a step whose conversation state has passed structural validation and has been published in exactly one `step.settled` event.
- **Turn snapshot:** the prompt, route, model profile, skill catalog, tool contract, capabilities, and prior context used for the next provider request. (Not yet represented as an explicit immutable type — see Remaining Work 5.)
- **Workspace checkpoint:** the existing Git-backed filesystem snapshot used by desktop restore and fork flows. It is orthogonal to conversation state.

### State machine

```text
idle
  -> snapshotting
  -> generating
  -> reconciling assistant output
  -> executing complete tool batch, when present
  -> validating conversation state
  -> settling the step
  -> generating the next step or settling the run
  -> idle
```

Compaction runs only from idle or after a settled step. It never runs inside an active step.

### Invariants

1. Only one operation runs in a session.
2. The turn snapshot is immutable during a provider request.
3. Nothing may be inserted between an assistant tool-call message and all results for that batch.
4. A parallel batch is validated as a whole before any call executes.
5. Every announced tool call receives exactly one terminal result, including cancellation and permission denial.
6. Tool results are stored in tool-call index order even when execution finishes out of order.
7. Model, reasoning, active-tool, skill, context, and queued-user changes are deferred until the current step settles.
8. The next provider request is built from the settled conversation state, then its token count is recomputed.
9. A run becomes idle only after all terminal lifecycle events, the latest completed or reconciled step has emitted `step.settled` when a step exists, and exactly one `run.settled` has been emitted.
10. The desktop persists the `conversationState` from each `step.settled` before treating that step as settled locally or acting on queued input.
11. Restoring or forking a workspace checkpoint changes filesystem state only. Recovering conversation state changes model history only. Neither operation implicitly performs the other.

## Landed and verified

Each item below was verified against the current code, not assumed from the old plan.

1. **Settled-step lifecycle.** `ContextStateV1`, its `version` field, `ChatRecord.contextState`, the `GET /session/:id/context` pull, and the post-`session.idle` write are gone. The unversioned `ConversationState` (`sourceTaskId`, `updatedAt`, `summary`, `tail`, `sourceDigest`, `usage`) exists identically in the runner (`packages/runner/src/conversation_state.rs`) and desktop (`types.ts`, `desktopApi.ts`) with `deny_unknown_fields` semantics on both sides, including an explicit test that a legacy versioned payload is rejected.
2. **Terminal events.** `session.idle` no longer exists; the decoder rejects it by test. `run.settled` is the only run-terminal event (exactly one per run, on both success and failure paths), `step.settled` carries the conversation state and is persisted synchronously before queued input is acted on, and `runner.error` is diagnostic-only (`runnerEventAdapter` holds it as pending failure until `run.settled`).
2. **Cancellation as reconciliation.** Abort walks history for announced-but-unresolved tool calls, appends a typed `aborted` terminal result for each, publishes `step.settled` with `outcome: interrupted`, resolves pending permissions as aborted, and emits exactly one `run.settled` with `outcome: aborted`. The desktop waits a 2-second graceful deadline before hard-killing the runner.
3. **Acknowledged queue.** Steer/follow-up/cancel go through `POST /session/{id}/queue` with `run.queue.updated` acks (capacity: one steer, eight follow-ups; stable reason codes). Dequeue happens only after the run guard drops and `run.settled` is emitted. The desktop launches a steer replacement only on a matching `dequeued` ack, never from event timing, and never calls `/abort` for steer.
4. **Guaranteed skill loading.** `skill.selected` is deleted everywhere. Explicit mention/UI selection becomes validated `selectedSkillIds` request metadata; a harness preflight loads each selected skill through the bounded loader before the first model request, emits `skill.requested` then exactly one of `skill.loaded` (`contentHash`, `bytes`) or `skill.failed` (stable `code`, bounded `message`) with `origin: harness|model`, caches once per content hash, and a failed explicit load stops the run before generation.
5. **Fixed runtime modes.** `VEIL_PROVIDER_PROTOCOL` is replaced by trusted startup-only `VEIL_MODE` (`server`|`local`); the provider adapter and all endpoints are resolved once in `NewClient`, never per request. Console always starts server mode; the desktop launcher always starts local mode; the Console protocol selector is deleted with a negative UI test; legacy SQLite configuration rows with a `protocol` column are dropped, not migrated.
6. **Server-owned generation profile.** Temperature, top-p, max output tokens, reasoning effort, thinking budget, parallel tool calls, global/per-user concurrency, and queue timeout flow Console → typed SQLite config → allowlisted child env → Veil startup validation → `model.ChatRequest` → explicit vLLM request fields. Veil owns `tool_choice`/`parallel_tool_calls`; the runner can only lower the output-token budget. Local mode uses a small fixed profile.
7. **Exact workspace tools.** `search` (681 lines) and the entire coercion layer (aliases, double decoding, scalar/string coercion) are deleted with guard tests. `read` is one-based, returns raw un-numbered text, streams with bounded memory, and refuses directories; `ls`/`find`/`grep` are single-purpose with exact continuations; `edit` takes `edits[]` with unique-or-reject and overlap rejection; `write`/`edit` stage and atomically rename with backup, rollback, `stale_source` revalidation, and a distinct `rollback_failed` code; `apply_patch` hunks must match uniquely; `command` coalesces progress at 100 ms, keeps the tail, spools to the context store with a retrievable hash, reports exact captured/original bytes with explicit `capture_truncated`, has no silence kill, and settles the process tree before releasing the scheduler barrier.
8. **Batch discipline.** The whole parallel batch is validated before any call executes (size, duplicate IDs, undeclared tools, per-call schema, duplicate signatures); results are stored in call-index order; global and per-path serialization gates concurrent execution.
9. **Admission and streaming.** Bounded global and per-user semaphores with queue-timeout, stable `busy` + `Retry-After`; cancellation propagates desktop → runner (25 ms poll) → Veil (context) → vLLM (forced body close) with counters; SSE relays line-at-a-time with bounded scanners, per-chunk reasoning stripping, and bounded connection pools; queue/request/model/stream-idle timeouts are four separate knobs; Console shows an administrator-safe Load panel.
11. **No versioning, enforced.** Every internal contract version field is deleted: the telemetry bundle `schemaVersion`/`schema_version` pair, the backend UI event `version` stamp and its `unsupported_version` failure code, the runner↔Veil compaction `version` on both request and response, the `X-Umbratic-Stream-Version` header, the workspace-graph and LSP `schemaVersion`, the command-safety `schema_version`, the stored model-endpoint, skill-manifest, document-review, OCR, and company-credential format versions. Each of those consumers now validates exact shape instead — unknown fields, missing fields, and invalid values are rejected. `apps/desktop/tests/fixtures/telemetry-bundle.input.json` and its golden counterpart are one shared fixture checked by both the TypeScript producer test and the Go consumer test. `apps/desktop/tests/no-versioning-guard.test.ts` is the repo-wide grep guard; its two documented allowlists cover only externally owned shapes (signed entitlement document, LSP, SBOM), descriptive software-version strings from capability probes, and tests that assert a versioned payload is rejected. Residual legacy is gone with it: the `chat.contextState` fallback read, the renderer-visible `ModelEndpointSoftware` type and every `software` field and `UMBRATIC_*_MODEL_SOFTWARE` env sniff behind it, and `edit`'s unreachable patch-mode sniffing — `apply_patch` now has its own `ToolRequest::ApplyPatch` variant dispatched directly instead of an injected `mode` argument.

12. **CRLF-exact read→edit round trip.** `read` carries each line's own terminator, so its output is a byte-exact slice of the file on LF, CRLF, mixed-ending, and BOM files; the final terminator is left off so the slice still matches an unterminated last line. `edit` and `apply_patch` share one byte-exact unique-or-reject matcher (`patch::unique_match`/`replace_unique`); the patch-only `normalized_line_endings`/`with_line_endings` divergence is deleted and `parse_patch` keeps each patch line's own terminator. Whole-file mutations carry an explicit 8 MiB bound with a typed `file_too_large` code naming it, instead of a silent 512 KB mismatch with what `read` can stream. Gate A round-trip tests cover all four line-ending styles plus a CRLF patch.

13. **Fresh-code defects fixed.** `idle_reader.go` runs one pump goroutine that owns its buffer and hands out copies, so a timeout or cancellation can no longer leave a goroutine writing into a caller buffer; per-user admission buckets are reference counted and evicted when idle (`tracked_users` is reported); a slot release with nothing held is a counted `release_error_count` rather than a silent no-op; and a failed runtime scrape yields `runtime_state: degraded` with the numeric fields omitted, which Console renders explicitly, instead of a zeroed 200.

14. **One generated tool contract, frozen per task.** `tools/catalog.rs` defines each tool once — fields, types, limits, gate, description — and generates both the model-facing schema and the executing validator from that definition, so every limit exists exactly once (`read.limit` now declares its real 2,000 maximum). The hand-written validator in `request.rs` and the second schema walker in `contract.rs` are deleted; `contract.rs` keeps only batch rules (size, duplicate ids, duplicate signatures). Validation runs through `ToolRequest::parse` on every execution path including direct dispatch, and executors no longer re-clamp: `number_arg` supplies a default and nothing more. `tools/surface.rs` freezes the surface at task start — capability gates, LSP and workspace-graph services, the `run_program` allowlist, and `retrieve_context` — so step-N schemas are byte-identical to step 1; `retrieve_context` is always declared and answers a stable typed `context_not_available` when the store is empty. Functions are declared `strict` with closed objects. Failures carry a stable code (`invalid_arguments`, `tool_disabled`, `unknown_tool`) plus typed `details` naming the tool, field, expectation, and allowed fields, and invalid calls get at most two consecutive repair steps (`MAX_INVALID_CALL_REPAIRS`), separate from the ten-turn budget for tools that executed and failed.

15. **Typed results end to end.** `tool.finished` carries `details` and `continuation`; the desktop decoder validates them and the adapter forwards them onto `command.finished` and `tool.failed`, which telemetry reads instead of re-deriving from message text. Validation failures carry the typed field payload from the generated contract. `lsp` and `workspace_graph` return structured `details` with a short rendered `content` for the model rather than JSON stuffed into prose. `classify_kind` text sniffing is deleted: each tool declares its output `kind` in the catalog and compaction reads that.

16. **Explicit turn snapshot.** `turn_snapshot.rs` captures prompt assembly, route, model id, frozen tool contract, skill-catalog hash, capabilities, conversation digest, and the recomputed output budget into one owned value before each provider request; the request reads only the snapshot. Compaction re-snapshots rather than reusing stale assembly. A test mutates queued input and the context store mid-request and asserts the in-flight snapshot is unchanged.

17. **Server hardening for multi-user deployments.** Veil has an explicit lifecycle: `BeginDrain` refuses new model work with a stable `draining` code and `Retry-After` while in-flight streams finish, and `cmd/veil` handles SIGINT/SIGTERM by draining before `server.Shutdown` on a 30-second deadline. Readiness is tracked and reported in `/api/health` as `state` (`starting`/`ready`/`draining`) and latches on the first successful health check. **Readiness is deliberately not a gate** — refusing traffic until a probe succeeds can deadlock behind a slow runtime, which is worse than forwarding a request the runtime itself would reject; draining is the gate, readiness is the signal a load balancer routes on. One bounded pre-commit retry covers transport failures and 502/503 before any byte is forwarded; timeouts, non-retryable statuses, and anything after the first byte are never retried. Stream metrics report TTFT and duration p50/p95/p99 from a bounded ring, token totals, disconnect, invalid-stream, and retry counts, asserted by exact key set so no field can leak in unnoticed. Console `Test connection` now probes a streamed completion and a forced strict tool call instead of only listing the model.

18. **Compaction structural safety.** `safe_cut_point` walks a proposed cut back to a boundary that neither lands on a tool result nor orphans an announced tool call, and both the primary and the overflow-retry cut points go through it. Compaction refuses outright while any tool batch is unresolved, so it cannot run inside an active step. The rebuild-then-recount ordering was already correct and is now covered: the conversation state is replaced only after the summary, retained tail, digest, and recomputed token count all pass. A prompt-assembly snapshot test pins the exact segment order and the sorted skill catalog, which is what makes the vLLM prefix reusable across sessions.

## Current defects

None. Every defect recorded by this plan has been removed; the numbered items under **Landed and verified** name the change that removed each one.

## Remaining work

The code for every item in this plan has landed. What remains needs infrastructure this repository cannot provide by itself.

### 1. Qualify a pinned vLLM deployment (Gate B and Gate C)

The benchmark and soak criteria — delivered throughput at least 95% of direct vLLM, server-side pre-token overhead at most 25 ms p95, bounded memory at configured concurrency, no stream event lost, duplicated, or reordered — are measurements, not code. They need a real deployment. The Veil-side instrumentation they read is in place: TTFT and duration percentiles, token totals, disconnect and invalid-stream counts, retry count, and admission counters are all reported by `/api/runtime/metrics`.

When that deployment exists, pin and document one tested combination of vLLM version, model and tokenizer revisions, quantization, chat template, tool-call parser, reasoning parser, tool-choice behavior, and prefix caching, and use a server-owned per-tenant cache salt on shared deployments. Prompt, tool, and skill ordering is already deterministic and snapshot-tested, so prefix reuse depends only on the deployment side.

### 2. Shorten the protected prompt

Deferred deliberately. Prompt wording changes model behavior, and there is no way to tell an improvement from a regression without the outcome suite running against a real model. The assembly *order* is now pinned by a snapshot test, so shortening can proceed safely once Gate C can measure it.

## Success criteria

The program succeeds at two levels. Both are required; passing the mechanical gates while agents still fail tasks for harness reasons is not success.

### Harness level: mechanical truth (Gate A, every merge)

Deterministic fake providers and scripted tools. Harness-caused failures must be zero. `npm run test:all` must pass.

- one exclusive operation per session; no orphan or incomplete tool lifecycle;
- atomic settled-step conversation state and crash recovery from the last persisted settled step;
- graceful cancel reconciliation during generation, tool execution, permission wait, and streaming;
- exact steer, follow-up, cancel, rejection, and queue-clear ordering from acknowledgements only;
- guaranteed explicit skill preflight; failed explicit load stops before generation;
- strict generated tool validation on every execution path; no alias, coercion, silent repair, or silent clamp;
- read→edit round trips byte-exact on LF, CRLF, mixed-ending, and BOM files; ambiguous edits and hunks rejected;
- reported mutation effects match committed filesystem state; rollback failure blocks further mutation;
- bounded coalesced command output, retrievable to its hard cap with explicit overflow; timeout, cancellation, nonzero exit, truncation, and overflow have distinct typed results;
- fragmented UTF-8/JSON/SSE handling; parallel execution with ordered results;
- typed `details`/`continuation` consumed by events and metrics with no model-facing-text parsing;
- frozen per-task tool surface: step-N schemas byte-identical to step-1;
- no internal payload contains a version field (guard test);
- compaction preserves the objective and exact working state.

### Platform level: the harness measurably improves agentic outcomes

The point of the program is that models running on Umbratic fail less for reasons that are the harness's fault. Track these from the (de-versioned) telemetry counters and the deterministic suites, before and after each land:

- **Harness-fault rate:** malformed, lost, duplicated, orphaned, or mismatched tool calls per run. Target: zero, permanently.
- **First-pass valid tool-call rate and repair-step count:** rises when schemas are strict and singular; a regression here after a contract change is a defect, not model noise.
- **Edit reliability:** `edit_not_found` + `edit_ambiguous` per 100 edit calls. The CRLF fix should move this immediately on Windows workspaces.
- **Settlement truthfulness:** sampled audits where reported terminal results are compared to actual filesystem/process state; any divergence is a release blocker.
- **Recovery:** percentage of crash/cancel scenarios that resume cleanly from the last settled step with no manual repair.
- **Responsiveness under load:** cancel-to-idle latency, queue-ack latency, TTFT p95 at configured concurrency, and the Gate B throughput ratio.
- **Consistency:** identical task inputs against the deterministic fake provider produce identical event sequences, byte-identical tool schemas, and identical settled states across repeated runs and across server/local modes.

These are floors, not tuning targets: do not lengthen prompts, loosen schemas, or bias formatting to move them.

### Gate B: controlled server infrastructure (deployment qualification, not every PR)

Generation-only throughput, TTFT, queue, memory, cancellation, and deterministic concurrency benchmarks per Remaining Work 7.5.

### Gate C: live model qualification and soak (canary qualification)

Run the outcome suite repeatedly against the pinned vLLM deployment and a representative Ollama model, with repeated results and confidence bounds. Do not block a code change on a single stochastic result or a fixed one-percentage-point concurrency delta. Server qualification is primary; local results identify adapter and prompt regressions but do not define the server profile.

## Verification commands

Run focused project tests while developing. Before completing each repository change, run:

```sh
npm run test:all
```

Also run the Veil, Console, runner, and desktop checks required by their nearest `AGENTS.md` when that project changes.

## Final acceptance

The program is complete when:

- every defect under **Current defects** is gone;
- no internal contract carries a version field, and the guard test enforcing that passes;
- no backward-compatibility path remains for changed contracts;
- every session follows the explicit operation/run/step state machine and persists one conversation state per settled step;
- cancellation and steering settle valid history before new work begins;
- server mode can only use vLLM and local mode can only use Ollama, with one server-owned generation profile;
- the vLLM deployment passes streaming, strict-tool, parallel-tool, and reasoning readiness probes;
- explicit skill selection is guaranteed before the first model request;
- each core tool has one generated definition producing its schema and validator, a frozen per-task surface, and one typed terminal result consumed without text parsing;
- reads feed byte-exact edits on every line-ending style, ambiguous mutations are rejected, and command-output loss is never silent;
- deterministic tests show zero harness-caused malformed, lost, duplicated, orphaned, or mismatched tool calls;
- the full generation-only path sustains at least 95% of direct vLLM throughput at target concurrency;
- overload, timeout, cancellation, retry, and restart behavior are bounded and visible to administrators;
- repeated compaction preserves valid history and exact work state;
- the platform-level metrics above show the harness-fault rate at zero and no regression in first-pass tool-call or edit reliability;
- `npm run test:all` passes.
