# Umbratic Harness Reliability Plan

## Goal

Make Umbratic reliably reach the expected task outcome. Exact wording may vary, but the harness must consistently provide the same instructions, skills, tool definitions, validation, lifecycle, evidence, and failure behavior.

Server mode is the priority. It must support concurrent users and a high-throughput vLLM deployment without the harness becoming the bottleneck. Local mode must continue to work through Ollama.

## Fixed decisions

- Do not preserve backward compatibility. Producers and consumers change together. Delete legacy fields, aliases, parsers, migrations, dual writes, and fallback behavior.
- Accept one current internal wire contract. Reject any other shape instead of guessing or adapting it.
- Server mode uses vLLM only. Veil Console does not offer Ollama or a runtime selector.
- Local mode uses Ollama only. The desktop does not offer vLLM for an app-managed local Veil.
- Both modes go through Veil. The runner never calls a model runtime directly.
- Veil owns protected prompts, generation settings, model capabilities, tool-call mode, and the final runtime request.
- The runner owns the agent loop, canonical workspace-tool contract, validation, policy, permissions, scheduling, execution, and lifecycle events.
- The desktop owns durable local product state and persists the runner's conversation state after each settled step.
- **Workspace checkpoint** means only the existing Git/worktree restore point. Conversation lifecycle state never uses that name, never restores a worktree, and is never restored by a workspace-checkpoint action.
- Reliability means expected outcomes and truthful lifecycle state, not identical model text.
- Do not add a generic vLLM passthrough or expose provider details to the renderer.

## Target request path

```text
Server: Desktop -> local Runner -> hosted Veil -> private vLLM
Local:  Desktop -> local Runner -> local Veil  -> local Ollama
```

The Rust runner and workspace tools remain local in both modes. Server work moves model inference and model policy to hosted Veil and vLLM; it does not move workspace execution to the server.

## Required agent-loop lifecycle

### Definitions

- **Operation:** one exclusive session action, such as a run or compaction. A session has at most one active operation.
- **Run:** one user request plus any model/tool steps needed to settle it.
- **Step:** one complete assistant response and, when present, its complete tool-call batch and results.
- **Conversation state:** the validated bounded model history after a complete step. It never contains an incomplete assistant message, orphan tool result, or partial parallel batch.
- **Settled step:** a step whose conversation state has passed structural validation and has been published in exactly one `step.settled` event.
- **Turn snapshot:** the prompt, route, model profile, skill catalog, tool contract, capabilities, and prior context used for the next provider request.
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
  -> generating the next step or settling
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

## Change 1: One current contract

### Work

1. Replace the telemetry version split with one exact payload.
   - Remove the desktop `schemaVersion: 6` field and Veil's `schema_version == 4` branch.
   - Keep one checked-in golden telemetry fixture that both the TypeScript producer and Go consumer validate.
   - Reject unknown and missing fields.
2. Remove internal version selectors that exist only to choose an old shape, including the context-compaction `version` field.
3. Delete old field aliases, alternate event shapes, compatibility parsers, and obsolete tests.
4. Define one wire-contract ID for the runner-to-Veil API.
   - The ID changes only when the wire shape or semantics change, not on every build.
   - Veil accepts exactly one ID. Do not add negotiation or an old-ID allowlist.
   - A breaking contract requires a coordinated desktop and Veil release.
   - If a zero-downtime rollout is required, route old clients to a separate old deployment temporarily; one Veil binary still accepts one contract only.
5. Do not migrate incompatible Console model configuration rows. Recreate only the configuration table, preserve administrator accounts and secrets, and require the model settings to be entered again.

### Event contract cutover matrix

Every row lands atomically with its owning change. Update the producer, strict decoder, orchestration, persistence, renderer-facing event when applicable, telemetry, fixtures, and tests in the same land. Delete the old event name; do not adapt or dual-emit it.

| Current event | Target event | Producers | Required consumers in the cutover |
| --- | --- | --- | --- |
| `session.idle` | `run.settled` | Runner server lifecycle | Desktop runner-event decoder; main-process completion, steering, cancellation, and task-state orchestration; adapter outcome handling; runner and desktop lifecycle tests. `run.settled` is the only run-terminal event. `runner.error` may precede it as a diagnostic but never substitutes for it. |
| None | `step.settled` | Runner loop after bounded-history validation | Desktop runner-event decoder and synchronous conversation-state persistence; deferred-change and queued-input orchestration; crash-recovery and event-order tests. It is internal lifecycle state and does not create a renderer timeline row. |
| `skill.selected` | `skill.requested`, then exactly one of `skill.loaded` or `skill.failed` | Harness preflight and model-requested `read_skill` dispatch | Desktop runner-event decoder and adapter; shared persisted backend-event union and validator; renderer labels/details; telemetry; runner, adapter, renderer, contract, and telemetry fixtures. Selection input remains request metadata, not a lifecycle event. |
| None | `run.queue.updated` | Runner session control | Desktop decoder, composer/task orchestration, queue UI state, and steer/follow-up ordering tests. The desktop never derives queue acceptance from `run.settled` timing. |

### Done when

- No changed contract accepts two shapes.
- A contract mismatch fails before model work starts.
- Cross-service golden fixtures catch drift in the root test suite.

## Change 2: Settled steps and one durable conversation state

### Transactional steps and deferred changes

1. Represent operation, run, and step states explicitly in the runner.
2. Build one immutable turn snapshot before each provider request.
3. Append a complete assistant message and its complete tool-result batch as one logical step.
4. Rebuild and validate the bounded conversation state after the step.
5. Publish exactly one `step.settled` containing that state. The exact event fields are `taskId`, `sessionId`, `runId`, `stepId`, `outcome`, `conversationState`, and `at`; `outcome` is `completed` or `interrupted`.
6. Persist the event's `conversationState` in the desktop before local settlement, renderer completion, deferred changes, steer, or follow-up handling.
7. Build the next provider request only from the settled state and recompute its token count.
8. Add deterministic event-order and runner-crash tests that recover from the last persisted settled step.
9. On every normal or failed run path, publish exactly one `run.settled` after the final `step.settled` when the run produced a step, or after preflight terminal events when it did not. Its exact fields are `taskId`, `sessionId`, `runId`, `outcome`, `summary`, `errorCode`, and `at`; `summary` is a typed `RunSummary` or `null`, `errorCode` is a stable string or `null`, and `outcome` is `completed`, `failed`, `aborted`, `model_gave_up`, or `safety_limit`.

### Replace `ContextStateV1`; do not evolve it

The replacement is one unversioned `ConversationState` contract:

```text
ConversationState {
  sourceTaskId
  updatedAt
  summary: string or null
  tail: ContextMessage[]
  sourceDigest
  usage {
    estimatedPromptTokens
    observedPromptTokens: number or null
    compactionCount
  }
}
```

Use this exact shape in all four places: runner session seeding, `step.settled`, `ChatRecord.conversationState`, and compaction input/output. Reject unknown or missing fields and invalid digests or message topology.

Delete `ContextStateV1`, its `version`, `ChatRecord.contextState`, the session-create `contextState` field, the final `GET /session/:id/context` pull, and the post-`session.idle` write. Replace them with `ConversationState`, `conversationState`, and event-driven persistence. Do not dual-read, dual-write, reconstruct incompatible runner history from renderer events, or fall back to the V1 shape. At the coordinated cutover, discard stored V1 conversation state without interpreting it; retain unrelated chat metadata and visible event history.

### Done when

- A settled step has one validated state, one event, and one durable desktop value.
- A crash during the next step resumes from the preceding settled step with no orphan messages.
- No code contains `ContextStateV1`, `step.checkpointed`, or a conversation-history use of `checkpoint`.
- No mid-step mutation can alter provider history.

## Change 3: Cancellation reconciliation

Cancellation is a state transition, not just an HTTP abort:

1. Stop starting new provider or tool work.
2. Cancel the active provider request and running tools.
3. Resolve pending permissions as aborted.
4. Produce an `aborted` terminal result for every announced but unfinished tool call.
5. Discard incomplete streamed tool-call fragments. If a complete assistant tool-call message was accepted, retain it only with a complete aborted-result batch.
6. Mark user-visible partial assistant text as interrupted and keep future model history structurally valid.
7. Validate the reconciled state and publish the final `step.settled` with `outcome: interrupted`.
8. Emit exactly one `run.settled` with `outcome: aborted`, then transition to idle.
9. Hard-kill the runner only when graceful reconciliation exceeds a short deadline.

### Done when

- Cancel during generation, tool execution, permission wait, and output streaming always produces valid conversation state and one terminal run event.
- Every announced tool call has exactly one terminal result before `run.settled`.
- A hard process stop is only a timeout fallback.

## Change 4: Steer, follow-up, and queue control

Support three exact actions:

- **Steer:** interrupt the active step through Change 3 reconciliation, then insert the steering message before the next provider request.
- **Follow up:** let the run settle naturally, then begin the queued request.
- **Cancel:** reconcile and settle without starting another request.

Accept one pending steer and a bounded follow-up queue. Emit `run.queue.updated` for every accepted, rejected, dequeued, or cleared action. Its exact fields are `taskId`, `sessionId`, `runId`, `actionId`, `action`, `disposition`, `pendingSteer`, `followUpCount`, `followUpCapacity`, `reasonCode`, and `at`; `action` is `steer`, `follow_up`, or `cancel`, `disposition` is `accepted`, `rejected`, `dequeued`, or `cleared`, and nullable fields are present as `null`. A replacement or follow-up prompt starts only after the preceding `run.settled`; the desktop never launches it by treating `runner.error` or a disconnected stream as settlement.

### Done when

- Deterministic tests prove exact steer, follow-up, cancel, rejection, and queue-clear ordering.
- Desktop queue state is derived only from runner acknowledgements and queue events.
- No queued input can enter an active step or overtake an earlier accepted input.

## Change 5: Fixed runtime modes and one vLLM profile

### Runtime modes

1. Replace `VEIL_PROVIDER_PROTOCOL` with a trusted Veil mode: `server` or `local`.
2. Server mode uses fixed vLLM OpenAI-compatible chat, models, and metrics endpoints.
3. Local mode uses fixed Ollama chat, tags, and model-info endpoints.
4. Remove the runtime selector and `protocol` field from Veil Console UI, configuration, SQLite rows, supervisor logic, tests, and documentation.
5. Veil Console always starts Veil in server mode. The desktop local launcher always starts Veil in local mode.
6. Keep one Veil binary, but select its provider adapter once at trusted startup and never per request.

### Console generation settings

Add this small validated set under Advanced:

- Temperature: `0.0` to `2.0`
- Top P: greater than `0.0` and at most `1.0`
- Maximum output tokens: keep the existing setting
- Reasoning effort: `none`, `low`, `medium`, or `high`
- Thinking token budget: optional non-negative integer no greater than maximum output tokens
- Parallel tool calls: on or off
- Maximum concurrent requests
- Maximum concurrent requests per user
- Queue timeout

Do not expose raw JSON, arbitrary chat-template arguments, top-k, penalties, logits, or stop-token lists. Add a setting only when a supported model and an eval demonstrate a need.

### Veil behavior

1. Store the profile in typed Console configuration and pass it through the allowlisted Veil child environment.
2. Validate it at Console submission and Veil startup.
3. Add the values to `model.ChatRequest` and explicitly send them in every vLLM request.
4. Veil chooses `tool_choice` and `parallel_tool_calls`; the runner cannot override them.
5. A runner output-token request may lower the budget but cannot exceed Console policy.
6. Keep reasoning content private.
7. Give local Ollama a small fixed profile instead of duplicating the server administration surface in desktop settings.

### Done when

- Server mode cannot call Ollama and local mode cannot call vLLM.
- Runtime defaults cannot silently change server generation behavior.
- No provider choice or generation profile is renderer-visible or client-overridable.

## Change 6: Guaranteed skill loading

### Explicit skill preflight

1. Stop parsing an explicit `$skill` mention into direct full-body context injection.
2. Convert an explicit mention or UI selection into a validated `selectedSkillId` separate from user text.
3. Before the first model request, run the real bounded `read_skill` implementation as a harness-owned preflight action.
4. Emit the normal requested/terminal lifecycle with `origin: "harness"`.
5. Store the result as a harness resource entry. Do not fabricate an assistant message claiming the model requested it.
6. Fail before model generation when an explicitly selected skill cannot be loaded completely.
7. Load each selected skill content hash once per task. Model-discovered skills continue to use the ordinary `read_skill` tool.
8. Keep the enabled catalog immutable for the task and hash it in diagnostics.

Use one skill lifecycle. `skill.requested` has exact fields `taskId`, `sessionId`, `runId`, `requestId`, `skillId`, `source`, `origin`, and `at`, where `origin` is `harness` or `model`. It receives exactly one terminal event:

- `skill.loaded` repeats the identity fields and adds `contentHash`, `bytes`, and `at`.
- `skill.failed` repeats the identity fields and adds stable `code`, bounded `message`, and `at`.

Delete `skill.selected` from the runner, decoder, adapter, shared backend-event contract, renderer, telemetry, and all fixtures in this land. Do not derive successful loading from selection metadata or tool output text.

### Done when

- Explicit skill selection guarantees the skill is present on the first model request.
- A failed explicit skill load stops before model generation with one terminal lifecycle.
- A failed preflight emits `skill.failed` followed by one `run.settled` with `outcome: failed` and no fabricated step.
- A selected skill is loaded once per content hash and cannot change during the task.

## Change 7: Canonical tool definitions and terminal results

### What to take from Pi

Pi's default coding surface is deliberately small: `read`, `bash`, `edit`, and `write`. Its read-only surface adds `grep`, `find`, and `ls`. The useful reliability properties are single-purpose tools, short schemas, bounded outputs with actionable continuation, exact edits, one-write mutation semantics, per-file mutation serialization, and coalesced shell progress.

Adopt those semantics without copying Pi's weaker boundaries. Umbratic keeps workspace-only paths, policy-before-permission, the `command`/`run_program` split, the atomic multi-file patch transaction, and the path/global scheduler. Do not copy absolute-path access, automatic binary downloads, inherited shell state, no-default-timeout commands, temp-file paths exposed to the model, fuzzy edit matching, or compatibility argument repair.

Changes 7 through 10 remove these defects without combining their contract cutovers:

1. `read.offset` is described as zero-based but executed as one-based.
2. `read` prefixes every file line with a line number even though `edit.oldText` is supposed to be copied from the latest read result.
3. `read` overloads file reading and recursive directory listing, so `offset`, `limit`, and output shape change meaning by target type.
4. `search` combines a query mini-language, fuzzy path search, multi-term content search, listing, globbing, and exclusions in one schema.
5. `edit` and patch hunks replace the first match instead of rejecting a non-unique match.
6. `write` and single-file `edit` write directly to the target instead of staging and atomically replacing it.
7. Command output emits uncoalesced chunks, keeps the beginning rather than the useful tail when capped, permanently loses output beyond the capture cap, and kills legitimate silent commands after 30 seconds.
8. The runner still accepts field aliases, double-encoded arguments, scalar arrays, and string coercions even though the declared schemas are exact.

### One generated contract

1. Define each tool once in the runner: name, description, input fields, limits, access class, result metadata, error codes, and model-facing formatter.
2. Generate the model schema and runner validator from that definition. Mark vLLM functions as strict.
3. Express optional values as required nullable fields only when the pinned vLLM strict mode requires it; normalize `null` once at the boundary.
4. Parse the OpenAI argument string once and require one JSON object.
5. Delete double decoding, scalar-array conversion, string-to-number conversion, string-to-boolean conversion, field aliases, and executor fallbacks. A tool name changed by a later land remains the sole current name until that land, then is deleted atomically; never expose both names.
6. Use `path` for every single-path core workspace tool. Do not also accept `filePath`, `file_path`, `directory`, or another alias.
7. Expose the smallest configured surface, keep its order stable, and freeze it for the task. Declare `retrieve_context` at task start and give `context_not_available` one stable snapshotted result.
8. Keep at most two consecutive invalid-call repair steps. Return one concise error with the tool, field, expected type, and allowed fields.
9. Validate a complete parallel batch before executing any call. Preserve call-index order in history while allowing safe calls to execute concurrently.
10. Use the same logical definitions and result shapes in Ollama local mode; transport-specific schema annotations may differ but semantics may not.

### Terminal result contract

1. Every executor returns one typed result with `status`, stable `code`, one-line `summary`, bounded `content`, typed `details`, and optional `continuation`.
2. Use one status vocabulary: `success`, `validation_error`, `policy_blocked`, `permission_denied`, `runtime_error`, `timeout`, and `aborted`.
3. Model-facing text comes from one fixed formatter per tool. Desktop events, metrics, tests, and scheduling use typed fields and never parse that text.
4. Cancellation returns a terminal result only after the underlying operation has settled, so a lock is never released while work can still complete later.
5. Keep `read_skill`, `read_attachment`, `retrieve_context`, `lsp`, and `workspace_graph` as bounded evidence/resource tools. They use this same lifecycle and terminal envelope but are not aliases for core workspace tools.

### Verification

1. Snapshot every current tool schema, validator, formatter, success result, and error result.
2. Prove malformed arguments are parsed once and rejected without coercion or alias repair.
3. Prove a complete parallel batch is rejected before any executor starts when any call is invalid.
4. Run deterministic model fixtures for current tool selection and arguments. Tool semantics and lifecycle tests remain the binary gate.

### Done when

- The advertised schema, validator, executor, formatter, and tests have one meaning for every field.
- Every current executor returns the typed terminal envelope and every consumer uses typed fields.
- No silent repair, alias, coercion, double decoding, or model-facing-text parsing remains.
- Parallel calls always have complete, ordered lifecycles and committed effects match their terminal results.

## Change 8: Exact read-only workspace tools

Replace the runner's overloaded read-only workspace surface in one coordinated cutover:

| Tool | Exact responsibility and invariants |
| --- | --- |
| `read` | Read one UTF-8 text file. Input is `path`, optional one-based line `offset`, and optional line `limit`. Return raw file text without inserted line numbers, bounded from the head by both line and byte limits, plus exact shown/total ranges and `nextOffset`. Stream with bounded memory instead of rejecting a file merely because it is larger than the output cap. If one line exceeds the byte cap, return `line_too_long` with its line and byte size; never present a partial line as complete. Never list a directory. |
| `ls` | List one directory, non-recursively, with workspace-relative entries in stable lexical order and `/` on directories. Input is `path`, `offset`, and `limit`; continuation is entry-based. Use `find` for recursion. |
| `find` | Find workspace paths by one explicit glob under one `path`. Respect the same blocked/generated-path policy as every other enumerator. Return stable sorted relative paths, a result count, truncation state, and no fuzzy query language. Implement it inside the runner; never download a helper at runtime. |
| `grep` | Search text with one `pattern`, an explicit `literal` or `regex` mode, one `path`, optional glob, case mode, context-line count, and limit. Return `path:line: text`, coverage, truncation, and no hidden word splitting. Implement it inside the runner under the same path policy as `find`. |

Delete the runner workspace tool `search` in the same land that adds `ls`, `find`, and `grep`. Update its definition, dispatcher, enabled-tool configuration, policy and scheduler classifications, desktop runner-event classification, protected tool guidance, telemetry, deterministic model fixtures, and tests together. Do not retain a `search` alias or translate old arguments. The desktop-core `search-files` command is a separate bounded UI file-search capability and is not renamed or expanded by this change.

Read-only truncation reports exact totals and a typed continuation the next call can use. Snapshot success, empty, error, truncation, and continuation results for all four tools.

### Verification

1. Add read tests for LF, CRLF, BOM, Unicode, final-newline, large-file, long-line, and truncated-file cases.
2. Prove stable pagination, lexical ordering, glob behavior, literal and regex modes, case modes, coverage, path-policy parity, symlink rejection, and generated/secret-path blocking.
3. Prove no runner schema, configuration, prompt, fixture, adapter classification, or test still refers to the workspace tool `search`.

### Done when

- `read` has one-based line semantics, returns copyable raw text, and never lists directories.
- `ls`, `find`, and `grep` each have one purpose and exact continuations.
- The runner exposes no overloaded or legacy read-only workspace tool.

## Change 9: Exact atomic mutation tools

Change the mutation surface in one coordinated cutover:

| Tool | Exact responsibility and invariants |
| --- | --- |
| `edit` | Apply one or more exact replacements to one file with `path` and `edits[]`. Match every `oldText` against the same original snapshot; require each match to be unique and non-overlapping; reject the entire call on any mismatch; preserve BOM and line-ending style; stage one atomic write; return a bounded diff and first changed line. No whitespace, quote, Unicode, or fuzzy matching. |
| `write` | Create or fully replace one text file with `path` and `content`. Create parents after approval, revalidate whether the target was missing or unchanged, stage and atomically install the file, and return the UTF-8 bytes written plus whether the path was created or replaced. |
| `apply_patch` | Keep the current multi-file add/update/move/delete transaction. Require every hunk to match uniquely, snapshot and revalidate all source states around permission, commit atomically with rollback, and return per-file effects plus a bounded unified diff. |

Replace the single-replacement `edit` schema with `edits[]` atomically across the generated definition, validator, executor, protected tool guidance, fixtures, and tests. Delete the old fields and never accept both shapes.

Every mutation records target state before permission and revalidates it immediately before commit. An external change returns `stale_source` with no mutation. Success reports actual committed effects; failure before commit reports no effects. Rollback failure has one distinct terminal code and blocks further mutation until surfaced.

### Verification

1. Add read-to-edit round-trip tests for LF, CRLF, BOM, Unicode, final-newline, and bounded reads.
2. Prove multi-edit and multi-file patch atomicity, duplicate-match rejection, overlap rejection, external-change rejection, rollback, same-path serialization, and safe different-path concurrency.
3. Prove permission waits cannot overwrite a changed target and cancellation cannot release a path lock before settlement.

### Done when

- A model can copy `read` content directly into `edit.edits[].oldText`.
- No ambiguous edit or patch can modify a file.
- Every reported mutation effect matches committed filesystem state.

## Change 10: Bounded command and program execution

| Tool | Exact responsibility and invariants |
| --- | --- |
| `command` | Run one approved shell command with a bounded default and maximum `timeoutMs`. Keep the safe environment and process-tree cancellation. Coalesce progress at most once every 100 ms, retain the useful output tail, and spool redacted output to a bounded per-command store for `retrieve_context`. Report exact captured/original byte counts and `capture_truncated` if the hard store cap is exceeded. Report exit code and timeout explicitly, and never kill a process merely because it is silent. |
| `run_program` | Run one allowlisted executable by `programId` and `args` without shell parsing. Reuse the same timeout, cancellation, output, and result contract as `command`. |

Command truncation returns the useful tail and a context hash, never a renderer-visible temporary path. Full output remains retrievable up to the hard redacted store cap; overflow is explicit and never presented as complete. The process tree must settle before the terminal result releases the global scheduler barrier.

### Verification

1. Test split UTF-8, interleaved stdout/stderr, more than both capture limits, long silent work, progress coalescing, timeout, cancellation, nonzero exit, and full-output retrieval.
2. Prove no progress event exceeds the coalescing rate and no tool or terminal event is delayed behind batching.
3. Prove cancellation settles the complete process tree and output readers before the terminal result.

### Done when

- Large command output remains retrievable to the documented hard cap and all further loss is explicit.
- Progress cannot flood the event path.
- Timeout, cancellation, nonzero exit, truncation, and overflow have distinct typed results.

## Change 11: Readiness and truthful observability

### vLLM readiness

Pin and document one tested combination of:

- vLLM version;
- model and tokenizer revisions;
- quantization;
- chat template;
- tool-call parser;
- reasoning parser when reasoning is enabled;
- automatic tool choice and strict tool calling;
- prefix caching.

Veil Console does not launch or reconfigure vLLM. `Test connection` performs:

- exact model lookup;
- streamed completion;
- strict forced tool call;
- automatic tool call;
- two-call probe when parallel tools are enabled;
- reasoning probe when reasoning is enabled.

Applying a configuration fails when a required probe fails.

### Metrics

Keep operational metrics server-side and show only administrator-safe summaries in Veil Console:

- active requests, queue depth, and queue wait;
- TTFT and duration p50/p95/p99;
- prompt/output tokens and delivered token rate;
- timeout, cancellation, overload, disconnect, and invalid-stream counts;
- first-pass valid tool calls and repair steps;
- terminal tool and skill outcomes;
- prefix-cache interval hit rate, KV pressure, and preemption;
- prompt, skill-catalog, tool-contract, wire-contract, and deployment fingerprints.

Do not log prompts, responses, tool output, credentials, absolute paths, or private reasoning. Cache hit rate and first-pass tool-call rate are diagnostics, not optimization targets. Do not lengthen prompts or loosen schemas to improve them.

### Done when

- The Console gives a concise readiness result and actionable operational state.
- Telemetry distinguishes model, transport, lifecycle, tool, and overload failures without sensitive data.

## Change 12: Admission, streaming, and performance

### Admission and failure behavior

1. Add bounded global and per-user request semaphores in Veil. When no user identity exists, use the global bucket only.
2. Bound waiting by the configured queue timeout and return a stable busy error with `Retry-After`.
3. Propagate cancellation through desktop, runner, Veil, and vLLM.
4. Retry at most once and only before the request is semantically committed.
   - Heartbeats and SSE comments do not commit a response.
   - Forwarding assistant text or accepting a complete tool-call response commits it.
   - Never retry a partial committed response or after any tool execution.
5. Keep queue, request, model, and stream-idle timeouts separate.
6. Add warmup, readiness, and connection draining so restarts do not accept work early or terminate active streams abruptly.

### Fast path

1. Stream end to end without collecting a full response.
2. Reuse bounded HTTP connection pools.
3. Keep SSE parsing incremental and memory bounded.
4. Benchmark existing desktop delta batching first. If necessary, coalesce only adjacent assistant deltas on a short frame interval and never delay tool or terminal events.
5. Keep prompt, tool, and skill ordering deterministic for prefix reuse.
6. Use a server-owned per-tenant cache salt on shared deployments.

### Controlled infrastructure gate

Compare direct vLLM with the generation-only Veil and full streaming paths, without tools:

- delivered token throughput is at least 95% of direct vLLM throughput;
- server-side pre-token overhead is at most 25 ms at p95 on the same network;
- memory remains bounded during long streams and at configured concurrency;
- no stream event is lost, duplicated, or reordered.

Use a deterministic fake stream at 1,500 tokens per second as the binary concurrency gate. Use live vLLM for soak, queue, preemption, cache, and latency measurements. Do not make a one-percentage-point live-model task-success delta a binary release condition.

### Done when

- Deterministic load tests pass at the configured concurrency.
- The harness does not materially throttle a generation-only vLLM stream.
- Overload, retry, timeout, cancellation, and draining behavior is bounded.

## Change 13: Prompt and compaction cleanup

Do this only after the lifecycle, skill, tool, and runtime contracts are stable.

1. Shorten the protected prompt while retaining security, verification, permission, tool-lifecycle, and user-intent rules.
2. Snapshot exact prompt assembly and ordering. Update the snapshot only for an intentional prompt change.
3. Compact only at idle or after a settled step.
4. Never cut between an assistant tool-call message and any result.
5. Never cut through an incomplete parallel batch.
6. Use turn-aware cut points and safely summarize the prefix of an oversized turn.
7. Carry forward the previous summary and retain exact file operations, tests, permissions, blockers, and the latest objective.
8. Rebuild the final context first, then recompute its tokens. Do not reuse stale counters.
9. Replace the conversation state only after the summary, retained tail, digest, lifecycle validation, and token count all pass.
10. Preserve provider token calibration and bounded sanitized state.
11. Do not add an unbounded append-only transcript.
12. vLLM has no portable per-request equivalent of Pi's `cacheRetention: "none"`. If compaction measurably evicts useful prefixes, isolate it with a separate cache salt, scheduling class, or model pool. Do not invent an unsupported no-write flag.

### Done when

- Repeated compactions preserve valid history and exact work state.
- Compaction traffic cannot mutate an active step.
- Prompt cleanup does not reintroduce accidental ordering churn.

## Release gates

### Gate A: Deterministic lifecycle and outcome tests

This is the primary release gate:

- one exclusive operation per session;
- no orphan or incomplete tool lifecycle;
- atomic settled-step conversation state and crash recovery;
- graceful cancel reconciliation;
- exact steer and follow-up ordering;
- guaranteed explicit skill preflight;
- strict canonical tool validation;
- exact per-tool semantics, typed terminal results, and truthful committed effects;
- read-to-edit round trips and ambiguity rejection;
- bounded and coalesced command output, retrievable to its hard cap with explicit overflow;
- fragmented UTF-8/JSON/SSE handling;
- parallel execution with ordered results;
- requested file and command outcomes match tool evidence;
- compaction preserves the objective and exact working state.

Use deterministic fake providers and scripted tools. Harness-caused failures must be zero.

### Gate B: Controlled server infrastructure

Run generation-only throughput, TTFT, queue, memory, cancellation, and deterministic concurrency benchmarks. These gates evaluate infrastructure, not model answer quality.

### Gate C: Live model qualification and soak

Run the outcome suite repeatedly against the pinned vLLM deployment and a representative Ollama model. Use repeated results and confidence bounds to qualify a model profile and canary a deployment. Do not block a code change on a single stochastic result or a fixed one-percentage-point concurrency delta.

Server qualification is primary. Local results identify adapter and prompt regressions but do not define the server profile.

## Shipping order

Land thirteen focused changes:

1. Single current wire contract, telemetry repair, and the checked consumer matrix.
2. Settled-step lifecycle, `ConversationState`, event-driven desktop persistence, and crash recovery.
3. Cancellation reconciliation and terminal settlement.
4. Steer, follow-up, cancel, and acknowledged queue state.
5. Fixed server/local modes and server-owned generation profile.
6. Guaranteed skill preflight and the skill-event cutover.
7. Generated tool definitions, strict parsing, and typed terminal results for the current tool set.
8. Exact `read`, `ls`, `find`, and `grep`, with atomic removal of the runner `search` tool.
9. Exact atomic `edit`, `write`, and `apply_patch` mutations.
10. Bounded `command` and `run_program` execution and output retrieval.
11. Readiness probes and operational observability.
12. Admission control, retry/drain behavior, and controlled performance gates.
13. Prompt reduction and structurally safe compaction.

Each change must leave producers, consumers, tests, and documentation on the same exact contract before it lands.

## Verification commands

Run focused project tests while developing. Before completing each repository change, run:

```sh
npm run test:all
```

Also run the Veil, Console, runner, and desktop checks required by their nearest `AGENTS.md` when that project changes.

## Final acceptance criteria

The program is complete when:

- no backward-compatibility path remains for changed contracts;
- every session follows the explicit operation/run/step state machine and persists one conversation state per settled step;
- cancellation and steering settle valid history before new work begins;
- server mode can only use vLLM and local mode can only use Ollama;
- every server request uses one explicit server-owned generation profile;
- the vLLM deployment passes streaming, strict-tool, parallel-tool, and reasoning readiness probes;
- explicit skill selection is guaranteed before the first model request;
- each core tool has one purpose, one generated schema/validator, and one typed terminal result;
- reads feed exact edits, ambiguous mutations are rejected, and command-output loss is never silent;
- deterministic tests show zero harness-caused malformed, lost, duplicated, orphaned, or mismatched tool calls;
- the full generation-only path sustains at least 95% of direct vLLM throughput at target concurrency;
- overload, timeout, cancellation, retry, and restart behavior are bounded and visible to administrators;
- repeated compaction preserves valid history and exact work state;
- `npm run test:all` passes.
