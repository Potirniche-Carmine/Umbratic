---
title: Native macOS App Implementation Plan
category: implementation-plan
date: 2026-07-19
status: ready-for-implementation
tags:
  - umbratic
  - implementation-plan
  - macos
  - swiftui
  - rust
aliases:
  - Umbratic macOS implementation plan
---

# Native macOS app implementation plan

## Outcome

Deliver a native SwiftUI/AppKit version of Umbratic for macOS while keeping the React/Electron application specifically for Windows. Both shells must share the same Rust desktop business service, Rust runner, Go Veil implementation, storage schema, system skills, and versioned contracts.

This plan is self-contained. The implementer is not expected to have, fetch, inspect, or copy Osaurus. All useful reference patterns are specified below.

Read [[Research/Native macOS App Architecture Analysis|Native macOS App Architecture Analysis]] before starting. Use [[Implementation Plans/Implementation Plan Template|Implementation Plan Template]] for later plans.

## Final definition of done

- [ ] macOS ships a signed and notarized SwiftUI/AppKit `.app` and DMG.
- [ ] The macOS bundle and process tree contain no Electron, Chromium, Node, `.asar`, preload, or React renderer.
- [ ] Windows continues to ship Electron and has no feature regression.
- [ ] Both shells use the same `umbratic-desktop-host` Rust process for all business behavior.
- [ ] Both shells use `umbratic-runner` from the same Cargo package, version, contract, and lockfile.
- [ ] Veil remains the only model boundary in local and server modes.
- [ ] Every preload operation and every current visible UI behavior has a passing parity row.
- [ ] Chats, projects, tasks, settings, notes, skills, attachments, diagnostics, and reviews survive upgrade.
- [ ] All automated, manual, packaging, security, accessibility, and performance gates in this plan pass with saved evidence.
- [ ] A saved packaged-Electron versus packaged-native comparison proves the required improvements in launch/opening time, physical footprint/RSS, CPU/energy behavior, process count, disk usage/growth, and UI responsiveness.
- [ ] App quit, failed launch, and task cancellation leave no child processes.
- [ ] The macOS Electron packaging lane is removed only after the rollback window succeeds.

## Hard invariants

These are review blockers, not suggestions.

1. Do not port Electron-main business rules into Swift.
2. Do not add a TypeScript, Swift, or Node runner fallback.
3. Do not call Ollama, vLLM, or another model runtime from either UI or the desktop host; all model traffic goes through Veil.
4. Do not grow `umbratic-desktop-core` into a runner or desktop host. It remains bounded search unless its search implementation is extracted into a small Rust library used by the unchanged binary and host.
5. Do not let either renderer receive the desktop-host auth token, runner password, Veil token, provider secret, protected prompt, or raw sensitive telemetry.
6. Do not let UI validation replace host or runner validation.
7. Do not open SQLite from Swift or Electron after host cutover.
8. Do not place endpoint secrets in SQLite. macOS uses Keychain; Windows retains Electron `safeStorage`; the host receives the current secret only in memory.
9. Do not claim parity from source inspection. Each row requires automated evidence or a recorded manual check.
10. Do not remove the old macOS package until the native build has passed production rollout and rollback criteria.

## Sources of truth available to the implementer

All required product source is inside UmbraticCode:

- `AGENTS.md` and nearest nested `AGENTS.md` files for repository rules;
- `apps/desktop/src/preload/preload.ts` for the current callable desktop surface;
- `apps/desktop/src/main/` for behavior to extract;
- `apps/desktop/src/renderer/` for the Windows UI and visual/state behavior to reproduce;
- `apps/desktop/tests/` for existing contracts and edge cases;
- `packages/runner/` for the runner implementation and contract;
- `packages/runner/tests/native-runner.test.ts` for black-box runner proof;
- `infrastructure/veil/` for the only supported model boundary;
- `reports/rust-rewrite-analysis.md` and `reports/performance/` for the performance baseline;
- `.github/workflows/package-desktop.yml` for the current release lane;
- `docs/supply-chain.md` and `supply-chain-policy.json` for dependency rules.

The implementer must record the starting product version and environment, and must not treat this plan’s file-line locations as fixed after refactors.

## Target repository shape

Create the following structure. Names may change only through a recorded architecture decision.

```text
UmbraticCode/
  apps/
    desktop/                         # Windows Electron shell after cutover
      src/main/                      # thin window, bridge, credential, dialog adapter
      src/preload/
      src/renderer/
    macos/
      App/
        Umbratic.xcodeproj/
        Umbratic/
          UmbraticMain.swift
          AppDelegate.swift
          MainWindowController.swift
          Assets.xcassets/
          Info.plist
          Umbratic.entitlements
        UmbraticTests/
        UmbraticUITests/
      Packages/
        UmbraticMacCore/
          Package.swift
          Sources/UmbraticMacCore/
            Application/
            DesktopHost/
            Models/
            Views/
            Components/
            Platform/
          Tests/UmbraticMacCoreTests/
      scripts/
        build-sidecars.sh
        verify-bundle.sh
        package-dmg.sh
        benchmark-macos.sh
  packages/
    desktop-host/                    # new Rust crate: shared desktop behavior
      Cargo.toml
      src/
        main.rs
        lib.rs
        api.rs
        auth.rs
        contracts.rs
        app_state.rs
        attachments.rs
        capabilities.rs
        config.rs
        credentials.rs              # in-memory credential input only
        diagnostics.rs
        events.rs
        ide.rs
        local_veil.rs
        ocr.rs
        policy.rs
        process.rs
        projects.rs
        prompt_context.rs
        review.rs
        runner_adapter.rs
        skills.rs
        storage.rs
        tasks.rs
        telemetry.rs
        worktrees.rs
      tests/
    desktop-contract/
      protocol.json
      methods.json
      schemas/
      fixtures/
      scenarios/
  scripts/
    benchmark-desktop-host.ts
    compare-desktop-performance.ts
    verify-desktop-parity.ts
```

Keep the root Cargo workspace authoritative and add `packages/desktop-host`. Do not create a separate unlocked Cargo graph.

## Required architecture contracts

### Desktop-host wire protocol

Use a small custom authenticated local protocol; do not add a large RPC framework.

Request:

```json
{
  "protocolVersion": 1,
  "id": "request-uuid",
  "method": "chat.list",
  "params": {}
}
```

Success:

```json
{
  "protocolVersion": 1,
  "id": "request-uuid",
  "ok": true,
  "result": []
}
```

Failure:

```json
{
  "protocolVersion": 1,
  "id": "request-uuid",
  "ok": false,
  "error": {
    "code": "invalid_input",
    "message": "A non-sensitive user-facing message."
  }
}
```

Event stream:

```text
id: 1042
event: backend
data: {"version":1,"type":"assistant.delta","taskId":"task-...","text":"..."}

```

Requirements:

- bind only to an explicit loopback IP;
- authenticate every RPC, event, health, and shutdown request;
- use `Authorization: Bearer <random launch secret>` with constant-time comparison;
- pass the launch secret through inherited stdin/pipe, never the command line;
- apply `no-store` and `no-cache` response headers;
- accept only `POST` RPC and `GET` SSE/health;
- enforce method allowlist, JSON-object params, duplicate request-id rejection, and body limits before deserialization;
- give each emitted event a monotonic sequence id and retain a bounded replay buffer;
- accept a last-event cursor and replay if available; otherwise require a full state refresh;
- keep the existing `BackendUiEventV1` variants and version during migration;
- never echo arbitrary input or absolute paths in protocol errors;
- include a `protocolVersion`, `hostVersion`, `runnerContractVersion`, and storage schema version in health;
- close active streams and children on authenticated shutdown.

### Canonical contracts and fixtures

`packages/desktop-contract` is language-neutral evidence, not a runtime npm dependency.

It must contain:

- every RPC method name and parameter/result schema;
- every backend event variant;
- stable error codes;
- representative success, empty, malformed, boundary, and failure fixtures;
- parity scenarios that describe ordered calls and expected normalized results/events;
- a compatibility policy for additive versus breaking changes.

Rust owns canonical serialization. A Rust test exports or verifies the checked-in fixtures. TypeScript and Swift tests decode the same fixtures. Do not rely on uncommitted generated files or an online code generator.

### Shell-action boundary

Native dialogs and OS presentation stay in the clients, but authorization stays in the host.

Flow for a selected path:

1. the user invokes a native open/folder panel;
2. the shell sends the selected path to a specific host method;
3. the host canonicalizes and validates it, performs the business action, and returns public data;
4. for a later “open/reveal” action, the host returns a short-lived opaque action id bound to a validated path and action kind;
5. the shell redeems the action id and invokes `NSWorkspace` or Electron `shell` without accepting a renderer-supplied arbitrary path.

This keeps native panels native while preventing the UI from becoming the security boundary.

## Complete operation-parity ledger

Create `packages/desktop-contract/methods.json` from this ledger before implementation. Each row needs Rust host tests, a Windows adapter test, and a Swift client test unless marked platform-only.

### Chats, projects, and notes

- [ ] `listProjects` → `project.list`
- [ ] `listChats` → `chat.list`
- [ ] `createChat` → `chat.create`
- [ ] `updateChatDraft` → `chat.updateDraft`
- [ ] `updateChatProject` → `chat.updateProject`
- [ ] `deleteChat` → `chat.delete`
- [ ] `deleteProjectChats` → `project.deleteChats`
- [ ] `deleteProject` → `project.delete`
- [ ] `getNotes` → `notes.get`
- [ ] `updateNotes` → `notes.update`

### Task, review, and feedback

- [ ] `getTask` → `task.get`
- [ ] `refreshTaskReview` → `review.refreshTask`
- [ ] `refreshWorkspaceReview` → `review.refreshWorkspace`
- [ ] `startTask` → `task.start`
- [ ] `approveWorktreeCreation` → `task.replyWorktree`
- [ ] `respondToToolPermission` → `task.replyPermission`
- [ ] `approveTaskMerge` → `task.approve`
- [ ] `rejectTask` → `task.reject`
- [ ] `keepWorktree` → `task.keepWorktree`
- [ ] `cancelTask` → `task.cancel`
- [ ] `setResponseFeedback` → `feedback.set`

### Repository, branches, files, and attachments

- [ ] `searchFiles` → `file.search`
- [ ] `pickRepository` becomes native picker + `repository.inspect`
- [ ] `pickAttachmentFiles` becomes native picker + `attachment.import`
- [ ] `savePastedAttachments` → `attachment.savePasted`
- [ ] `openChatAttachment` → `attachment.authorizeOpen` + shell action
- [ ] `getRepository` → `repository.get`
- [ ] `listRepositoryBranches` → `repository.listBranches`
- [ ] `checkoutRepositoryBranch` → `repository.checkoutBranch`

### Status, settings, endpoint, and capability probes

- [ ] `getBackendStatus` → `status.get`
- [ ] `getCapabilityProbes` → `capability.probe`
- [ ] `getHarnessProfile` → `settings.getHarness`
- [ ] `saveHarnessProfile` → `settings.setHarness`
- [ ] `getContextLength` → `settings.getContextLength`
- [ ] `saveContextLength` → `settings.setContextLength`
- [ ] `getModelEndpointSettings` → `settings.getEndpoint` with only `secretConfigured`
- [ ] `saveModelEndpointSettings` → credential adapter + `settings.setEndpoint`
- [ ] `setPermissionMode` → `settings.setPermissionMode`
- [ ] `listAvailableIdes` → `ide.list`
- [ ] `openRepositoryInIde` → `ide.authorizeRepositoryOpen` + shell action or host-controlled launch
- [ ] `openTaskInIde` → `ide.authorizeTaskOpen` + shell action or host-controlled launch
- [ ] `setWindowChromeTheme` remains a Windows shell operation; native macOS applies `NSAppearance`

### Skills, diagnostics, and telemetry

- [ ] `listSkills` → `skill.list`
- [ ] `saveSkillSettings` → `skill.setEnabled`
- [ ] `openSkillsFolder` → `skill.authorizeFolderOpen` + shell action
- [ ] `openRunnerDiagnosticsFolder` → `diagnostics.authorizeFolderOpen` + shell action
- [ ] `openSkillInEditor` → `skill.authorizeEditorOpen` + shell action
- [ ] `importSkill` becomes native picker + `skill.import`
- [ ] `createSkill` → `skill.create`
- [ ] `getSkillDocument` → `skill.getDocument`
- [ ] `saveSkillDocument` → `skill.saveDocument`
- [ ] `resetSystemSkill` → `skill.resetSystem`
- [ ] `exportTelemetry` → host creates bounded export + native save panel/copy
- [ ] `exportLocalDiagnostics` → host creates bounded export + native save panel/copy
- [ ] `clearLocalDiagnostics` → `diagnostics.clear`
- [ ] `recordProductEvent` → `telemetry.recordProductEvent`
- [ ] `onBackendEvent` → authenticated `GET /events` with cursor replay

## Source-to-shared-host migration map

Move behavior in this order. Keep the old TypeScript implementation available behind a development-only feature flag until the corresponding host parity suite passes.

| Existing source | New Rust module | Required proof |
|---|---|---|
| `shared/backendEvents.ts` | `contracts.rs`, `events.rs` | every current variant round-trips; malformed/future events rejected |
| `shared/chatTitle.ts` | `projects.rs` or `tasks.rs` | existing title tests ported as fixtures |
| `shared/contextWindow.ts` | `prompt_context.rs` | all thresholds/reserves/excerpts match fixtures |
| `shared/reviewDiff.ts` | `review.rs` | parsing, alignment, intra-line, hashes match fixtures |
| review comment serializer | `review.rs` | deterministic/stale/visible prompt fixtures |
| `artifactRuntime.ts` | `capabilities.rs`/`ocr.rs` | artifact intent fixtures |
| `attachmentContext.ts` | `attachments.rs` | dedupe, recency, hidden-path fixtures |
| `backendEventBuffer.ts` | `events.rs` | delta coalescing and boundary fixtures |
| `capabilities.ts` | `capabilities.rs` | real fake-PATH probes and redacted telemetry |
| `config.ts`, `toolSettings.ts` | `config.rs` | env/default/managed-setting fixtures |
| `diagnostics.ts` | `diagnostics.rs` | secret/path/prompt redaction tests |
| `fileSearch.ts` | `attachments.rs` or direct helper adapter | same binary resolution and malformed-output tests |
| `historyContext.ts`, `promptContext.ts` | `prompt_context.rs` | newest-context and image-limit fixtures |
| `localVeil.ts`, `veilContext.ts` | `local_veil.rs` | readiness, auth, config, exit, timeout, no telemetry |
| `ocrRuntime.ts`, PDF worker | `ocr.rs` | image/PDF limits, local outputs, malformed worker data |
| `policy.ts` | `policy.rs` | all block/allow and hardening assertions |
| `providerClient.ts` | `local_veil.rs`/`config.rs` | endpoint errors, auth, timeout, body limits |
| `runnerAdapter.ts` | `runner_adapter.rs` | same runner config, auth, SSE split chunks, cleanup |
| `runnerAssistantOutput.ts` | `events.rs` | reasoning/final answer boundary fixtures |
| `skills.ts` | `skills.rs` | system/personal CRUD, zip/path/symlink/size rules |
| `storage.ts` | `storage.rs` | fixture DB migrations and exact normalization |
| `telemetry.ts`, `telemetrySync.ts` | `telemetry.rs` | redaction, rated/failed inclusion, spool retry |
| task/worktree/review functions in `main.ts` | `tasks.rs`, `worktrees.rs`, `review.rs` | end-to-end parity scenarios and real filesystem fixtures |

## Required before-and-after performance protocol

Performance is a release requirement, not a final subjective check. Phase 0 must measure the current packaged Electron macOS application, and Phase 11 must measure the packaged native macOS application with the same harness, fixture data, workloads, host, and reporting schema.

### Comparison rules

- Use production-style Release builds. Do not compare a Vite development launch with a packaged native launch.
- Use the same physical Mac, macOS version, architecture, display configuration, power source, thermal state, and fixture directory for baseline and final measurements.
- Record hardware model, CPU/core count, installed RAM, storage type/free space, macOS version, architecture, display scale, power source, and tool versions in every report.
- Close unrelated foreground applications and wait for the machine to return to a stable idle state before each sample group. Do not disable ordinary macOS security services to improve results.
- Use a deterministic local fake Veil/model response for shell and rendering benchmarks. Measure real model-runtime resource use separately because model choice and context size otherwise dominate the comparison.
- Use a fixed synthetic profile with no private data: 20 projects, 100 chats, one 500-item mixed timeline, a 20-file/5,000-line review, representative attachments, skills, settings, and diagnostics.
- Run launch workloads at least 10 times and sustained interaction workloads at least 5 times. Measure idle behavior for five continuous minutes after a 30-second settling period.
- Save every raw sample. Report median, p95, minimum, maximum, and sample count; do not report only the best run.
- Report CPU percentage with `100%` defined as one fully occupied logical core. Also record process CPU seconds so results are not distorted by different wall-clock duration.
- Report both per-process RSS and aggregate physical footprint. RSS is retained for comparison with the current checked-in Electron benchmark; physical footprint is the primary macOS memory gate because summing RSS can double-count shared pages.
- Exclude model files, selected workspaces, and user-authored task output from application disk-size totals. Report them separately when a scenario intentionally creates artifacts.
- A threshold may be changed only before the native result is collected, with the reason and replacement threshold recorded in the evidence report. Do not loosen a threshold after seeing a failing final result.

### Benchmark workloads

| ID | Workload | Fixed setup and action | Required measurements |
|---|---|---|---|
| `PERF-L1` | Clean-profile launch | New empty app-data directory; start app; wait until the main window accepts input; do not start runner or Veil | process start → first frame, host-ready, interactive; CPU seconds; peak/settled memory; process count; disk written |
| `PERF-L2` | Populated-profile launch | Fixed synthetic profile; launch directly to the 500-item chat | start → first frame, host-ready, interactive, timeline visible; CPU seconds; peak/settled memory |
| `PERF-L3` | Warm relaunch | Relaunch the unchanged populated profile after a normal quit | the same launch markers as `PERF-L2`; verify no child remained from the prior run |
| `PERF-I1` | Five-minute idle | Populated app open, no animations, no active task, window visible | mean/p95 CPU, CPU seconds, physical footprint/RSS slope, wakeups, disk/cache/log growth |
| `PERF-C1` | Large conversation | Open the 500-item mixed chat, scroll end-to-end twice, expand/collapse 20 activity rows, copy one response | chat-open latency, main-thread hangs, frame/hitch data, CPU, peak memory, post-close memory |
| `PERF-S1` | Streaming | Fake host emits the fixed assistant/reasoning/tool event fixture at the fixed event rate | delivery-to-visible latency, render-queue depth, dropped/coalesced events, CPU, peak memory, terminal-event latency |
| `PERF-R1` | Large review | Open the fixed 20-file/5,000-line diff, switch split/unified, wrap, select lines, add feedback, close | review-open and mode-switch latency, scroll hitches, CPU, peak/post-close memory |
| `PERF-T1` | Deterministic task | Host launches the real runner and Veil against a fake model service; one read tool, one permission, one write, review-ready | per-process CPU/RSS/footprint, peak process count, startup latency, cleanup latency; model-runtime memory excluded |
| `PERF-F1` | Repository search | Existing fixed queries and result limit on the same repository fixture | median/p95 latency, CPU time, result checksum |
| `PERF-D1` | Disk growth | Measure clean install/profile; create 100 chats and 20 deterministic tasks; relaunch normally 10 times | DMG, installed app, sidecar, initial user data, final user data, cache/log/temp growth and retained artifacts |
| `PERF-Q1` | Quit and cleanup | Quit while idle, streaming, waiting for permission, and after review close | time to exit, descendant count after exit, remaining temp/cache data |

### Required metrics and tools

The benchmark harness must collect these metrics into machine-readable JSON. Prefer deterministic scripts over reading Activity Monitor by eye.

| Category | Metrics | macOS collection approach |
|---|---|---|
| Launch | first frame, host-ready, interactive, populated timeline visible | app `os_signpost` markers plus monotonic timestamps observed by the harness |
| Memory | current/peak RSS per process; aggregate physical footprint; private, compressed, and dirty memory where available | process-tree sampler, `/usr/bin/time -l`, `footprint`, and `vmmap -summary` snapshots |
| CPU | user/system CPU seconds; mean/p95 CPU by process and process tree; peak CPU | fixed-interval `ps` sampling plus Instruments Time Profiler for representative runs |
| Responsiveness | main-thread hangs, frame hitches, chat/review open latency, mode-switch latency | Instruments Hangs/Time Profiler, signposts, and UI-test timestamps |
| Streaming | host-delivery → visible latency, maximum pending render queue, dropped/coalesced count, terminal latency | sequence-tagged fixture events and app render acknowledgements in test builds |
| Energy | wakeups/second, timer activity, energy impact during idle and stream | Instruments Energy Log and Time Profiler timer inspection |
| Disk | DMG bytes, installed `.app` bytes, sidecars/resources, app-support data, caches, logs, temp data, growth by workload | `du -sk`, `stat`, bundle manifest, and before/after directory inventory |
| Processes | idle/active count, start/stop time, surviving descendants | process-tree sampler keyed by the launched root process |

Do not require elevated privileges for the standard benchmark lane. If a deeper diagnostic tool requires approval or changes system state, keep it as an optional investigation and retain the standard comparable measurements.

### Benchmark artifact schema

Save results beneath `reports/performance/native-macos-migration/`:

```text
baseline/electron-macos.json
final/native-macos.json
comparison.json
instruments/<workload-id>/...
```

Each JSON report must include:

- schema version, variant, product/build identifier, architecture, configuration, and packaged artifact path;
- host hardware/OS/power/display metadata;
- exact fixture version and checksum;
- workload id, parameters, sample count, and raw samples;
- per-process and aggregate values;
- median/p95/min/max summaries;
- excluded processes/directories and the reason;
- threshold, pass/fail result, and any pre-approved exception.

The comparison report must show Electron baseline, native result, absolute difference, percentage difference, and gate result for every comparable metric.

## Phase 0 — Freeze the contract and baseline

### Implementation

- [ ] Record the starting product version, Node/npm/Rust/Go versions, macOS hardware, OS, and build configuration.
- [ ] Run the current complete test suite without changing source.
- [ ] Extend the desktop benchmark harness to implement every workload and metric in [[#Required before-and-after performance protocol]] before measuring the baseline.
- [ ] Build/package the current Electron macOS app in production-style configuration and run `PERF-L1` through `PERF-Q1`.
- [ ] Re-run the existing runner and file-search benchmarks and save all raw Electron results under `reports/performance/native-macos-migration/baseline/`.
- [ ] Save representative Instruments traces for idle, large conversation, streaming, and large review workloads.
- [ ] Confirm the baseline report includes launch, physical footprint, RSS, CPU seconds/percentage, wakeups, process count, installed/DMG/user-data disk usage, responsiveness, and cleanup—not only startup time and RSS.
- [ ] Capture light and dark screenshots at 980×680, 1320×860, and a wide review layout for every major UI state.
- [ ] Capture a short screen recording of streaming, permission approval, stop, review comments, accept, reject, settings, and attachment flows.
- [ ] Export the preload method list and `BackendUiEventV1` variants into the contract package.
- [ ] Create `docs/native-macos-parity-ledger.md` with one row per operation and visual state, columns for Windows, host, macOS, automated evidence, manual evidence, and status.
- [ ] Mark every row `UNPROVEN`; do not begin with optimistic pass states.

### Commands

```sh
npm ci --ignore-scripts
cargo fetch --locked
npm run dependencies:provision
npm run test:all
npm run desktop:build
npm --workspace @umbratic/desktop run package -- --mac dmg
npm --workspace @umbratic/desktop run verify:package
node scripts/benchmark-runner.ts
node scripts/benchmark-desktop-search.ts
node scripts/benchmark-desktop.ts \
  --variant electron-macos \
  --artifact /absolute/path/to/packaged/Umbratic.app \
  --fixture /absolute/path/to/performance-fixture \
  --output reports/performance/native-macos-migration/baseline/electron-macos.json
```

### Verify

- Existing tests pass or every pre-existing failure is recorded before implementation.
- Benchmark reports contain raw samples, host metadata, fixed fixture checksum, all `PERF-*` workloads, and complete CPU/memory/disk/launch measurements.
- The packaged Electron baseline can be reproduced from the saved instructions without a development server.
- The parity ledger includes every method in `preload.ts`, every backend event variant, and every UI state listed in the analysis.
- Screenshots do not contain secrets or private workspace content; use a deterministic fixture repository.

### Phase success state

The team has a reproducible packaged Electron baseline and can detect behavior, UI, security, packaging, launch, RAM/physical-footprint, CPU, energy, disk-growth, responsiveness, or runner regressions without Osaurus.

## Phase 1 — Establish the language-neutral desktop contract

### Implementation

- [ ] Add `packages/desktop-contract/protocol.json` with protocol version and compatibility rules.
- [ ] Add `methods.json`, schemas, fixtures, and scenario manifests for the complete ledger.
- [ ] Preserve `BackendUiEventV1` field names and semantics.
- [ ] Define stable error codes: `invalid_input`, `unauthorized`, `not_found`, `conflict`, `policy_denied`, `permission_denied`, `unavailable`, `timeout`, `cancelled`, `request_too_large`, `protocol_mismatch`, and `internal_error`.
- [ ] Add an operation-manifest test that fails if preload, Windows adapter, Swift client, and contract methods differ.
- [ ] Add fixtures for empty state, maximum allowed values, malformed JSON, unknown method, duplicate id, future protocol, oversized body, split UTF-8/SSE, reconnect cursor, and redacted error.
- [ ] Add a contract changelog rule: additive optional fields are compatible; renamed/removed fields, changed enum meaning, or stricter accepted input require a protocol-version decision.

### Tests

```sh
node --test apps/desktop/tests/backend-events-contract.test.ts
node --test apps/desktop/tests/preload-ipc.test.ts
npm run supply-chain:check
```

### Verify

- TypeScript decodes every success/error/event fixture.
- A placeholder Swift package test decodes the same JSON with `Codable` without custom lossy fallbacks.
- No fixture contains credentials, absolute user paths, protected prompts, or raw command output.
- Unknown and future variants fail closed with a diagnostic-safe error.

### Phase success state

There is one auditable protocol and fixture set from which Rust, Windows, and macOS behavior can be tested independently.

## Phase 2 — Build the Rust desktop-host foundation

### Implementation

- [ ] Add `packages/desktop-host` to the root Cargo workspace.
- [ ] Use existing workspace dependencies where possible. Add a crate only after supply-chain review and lockfile update.
- [ ] Implement loopback bind, bearer auth, constant-time comparison, request/body limits, request-id tracking, health, shutdown, and SSE with cursor replay.
- [ ] Read the random auth token from stdin/pipe before listening. Zero temporary token buffers where practical.
- [ ] Print exactly one machine-readable startup handshake to stdout; send diagnostics to stderr.
- [ ] Add a `UMBRATIC_DESKTOP_HOST_SPAWN_CHECK=1` sentinel path that exits before global state.
- [ ] Implement an `AppState` with explicit service dependencies rather than process-wide mutable globals.
- [ ] Implement a process supervisor that tracks child identity, process group/job object, stdout/stderr bounds, readiness deadline, cancellation, graceful stop, forced stop, and exit reason.
- [ ] Add redacted structured diagnostics with warning/error levels only.
- [ ] Add a `serve` subcommand and deterministic test configuration.

### Tests

Cover:

- explicit IPv4 and IPv6 loopback accepted; hostname and non-loopback rejected;
- missing/wrong auth on every endpoint;
- constant-time comparison unit cases;
- empty, malformed, array-shaped, oversized, duplicate-id, unknown-method, and future-version requests;
- no-store/no-cache headers;
- SSE split UTF-8, split JSON, lag, replay, stale cursor, disconnect, and shutdown;
- startup timeout, early child exit, malformed handshake, forced termination, and no orphan;
- diagnostic redaction for tokens, headers, prompts, paths, command output, and stack data.

### Commands

```sh
cargo fmt --all -- --check
cargo test --locked --package umbratic-desktop-host --all-targets
cargo clippy --locked --package umbratic-desktop-host --all-targets -- -D warnings
npm run supply-chain:check
```

### Phase success state

Both a Node test client and Swift test client can start the real host, authenticate, call health, consume/reconnect to events, request shutdown, and prove the process exits with no descendants.

## Phase 3 — Move deterministic shared domains into Rust

Migrate pure logic before filesystem mutation or child processes. For each domain: port existing tests, run TypeScript and Rust against identical fixtures, switch contract calls, then mark only those parity rows `PASS`.

### 3A. Types, events, buffering, and assistant output

- [ ] Move task/chat/repository/review/public types to Rust serde types.
- [ ] Preserve all event field names and terminal-state meanings.
- [ ] Port event coalescing and reasoning/final-answer classification.
- [ ] Add sequence-id/event-id dedupe without changing the public event payload.
- [ ] Test cancellation and terminal outcome exactly once.

### 3B. Context, titles, attachments, and prompt facts

- [ ] Port chat-title rules, token estimates, output reserves, 75%/90% thresholds, attachment excerpts, recent-history bounds, and image limits.
- [ ] Keep client-to-model content factual; no prompts, route personas, model policy, or skill preselection in the host.
- [ ] Preserve full-document accounting while bounding initial context.
- [ ] Port agent-instruction discovery and repository-tree/key-file facts with the same path/size bounds.

### 3C. Review parsing and feedback

- [ ] Port patch parsing, stable hashes, hunk ids, split alignment, intra-line spans, binary/too-large handling, and status normalization.
- [ ] Have the host return canonical review files plus aligned rows; clients do not reimplement diff semantics.
- [ ] Move review-comment reconciliation and model-facing serialization into the host.
- [ ] Accept structured comments from clients; never accept a client-built hidden prompt suffix.

### 3D. Configuration, capability probes, policy, and diagnostics

- [ ] Port endpoint defaults, managed overrides, harness ids, context choices, tool settings, and runtime paths.
- [ ] Port executable/package capability probes using injected command runners in tests.
- [ ] Port policy classification and hardening assertions.
- [ ] Port diagnostic sanitization and telemetry-safe capability snapshots.

### Tests

Run existing TypeScript tests and new Rust fixture tests together until Windows switches to host:

```sh
node --test apps/desktop/tests/chat-title.test.ts
node --test apps/desktop/tests/context-window.test.ts
node --test apps/desktop/tests/main-attachment-context.test.ts
node --test apps/desktop/tests/main-backend-event-buffer.test.ts
node --test apps/desktop/tests/main-capabilities.test.ts
node --test apps/desktop/tests/main-diagnostics.test.ts
node --test apps/desktop/tests/main-history-context.test.ts
node --test apps/desktop/tests/main-policy.test.ts
node --test apps/desktop/tests/main-prompt-context.test.ts
node --test apps/desktop/tests/review-comments.test.ts
node --test apps/desktop/tests/review-diff.test.ts
node --test apps/desktop/tests/runner-assistant-output.test.ts
cargo test --locked --package umbratic-desktop-host --all-targets
```

### Phase success state

The same golden inputs produce byte-equivalent normalized JSON where ordering matters and semantically equivalent results elsewhere. No client decides prompt, policy, review, context, or diagnostic behavior.

## Phase 4 — Move storage, skills, attachments, telemetry, and process orchestration

### 4A. Storage and migration

- [ ] Implement existing SQLite schema and `PRAGMA user_version` migrations in Rust.
- [ ] Preserve project/task/chat order, normalization, and cross-project chat DB behavior.
- [ ] Open databases with explicit busy timeout, foreign keys, bounded transactions, and corruption errors.
- [ ] Back up the DB before the first host-owned migration using an atomic, versioned filename.
- [ ] Migrate legacy records idempotently and never rewrite unrelated rows for a single-record update.
- [ ] Keep diagnostics and product telemetry independently clearable.
- [ ] Add fixture databases for current, each legacy version, malformed payload rows, and interrupted migration.

### 4B. Credential boundary

- [ ] Define a host bootstrap call that accepts endpoint credentials only from a trusted shell after auth.
- [ ] Keep the value in memory, redact debug output, and clear it on endpoint change/shutdown.
- [ ] Persist only `secretConfigured` and non-secret endpoint settings.
- [ ] Reject model operations that need a secret when no credential is loaded with `credential_required` mapped to a user-facing prompt.

### 4C. Skills and attachments

- [ ] Port system-skill installation and personal/system discovery.
- [ ] Preserve ids, frontmatter parsing, symlink refusal, max sizes, reserved roots, zip validation, duplicate rejection, edit/reset behavior, and cross-platform paths.
- [ ] Port attachment copy, paste data URL parsing, MIME/extension handling, preview limits, OCR/PDF preparation, and hidden-review-path behavior.
- [ ] Keep all attachment paths scoped to their chat/repository and block secrets, traversal, symlinks, binaries, and oversize content as today.

### 4D. Telemetry and diagnostics

- [ ] Port bundle construction, exact redaction, rated-conversation inclusion, failed-tool attempted input/response inclusion, context crossings, product events, spool ordering, retry, and local/server mode behavior.
- [ ] Keep local diagnostic logs out of managed telemetry.
- [ ] Return export artifacts through a bounded host-owned staging area; the shell chooses the final destination.

### 4E. Veil, runner, search, and OCR supervisors

- [ ] Port local Veil environment, free-port behavior, transient token, readiness probes, activation, timeout, diagnostics parsing, and process-tree cleanup.
- [ ] Port runner binary resolution, configuration, runtime environment, authenticated client, event stream, permission reply, abort, and cleanup.
- [ ] Preserve `umbratic-runner` configuration validation and Veil-only provider route.
- [ ] Invoke the existing desktop-core binary for search initially. Extract a library only if benchmark evidence justifies eliminating the process launch.
- [ ] Port PDF/OCR helper orchestration with bounded output and timeouts.

### Tests

```sh
cargo test --locked --package umbratic-desktop-host --all-targets
cargo test --locked --package umbratic-runner --all-targets
cargo test --locked --package umbratic-desktop-core --all-targets
cargo clippy --locked --workspace --all-targets -- -D warnings
npm --workspace @umbratic/runner run test:all
npm run veil:test
npm run supply-chain:check
```

Add real-process tests for malformed output, early exit, readiness timeout, permission wait, cancellation, split SSE, child crash, and shutdown. Use a local deterministic fake Veil; do not skip tests when an external model service is absent.

### Phase success state

The host can open a fixture database, list/create/update state, manage skills and attachments, launch the real runner against fake Veil, stream a complete tool turn, handle permission, build review state, export redacted evidence, and shut down every child.

## Phase 5 — Move all task/worktree/review lifecycle into the host

### Implementation

- [ ] Port repository inspection for git and ordinary folders.
- [ ] Port hidden chats, chat/task linkage, task reuse, and running-task dedupe.
- [ ] Port local versus worktree start, worktree approval, branch naming, reusable worktrees, baseline snapshots, and per-turn review scope.
- [ ] Port task event persistence, bounded compaction, restart repair, and public-state normalization.
- [ ] Port runner prompt assembly and attachment preparation while keeping protected prompt behavior in Veil.
- [ ] Port runner event translation with exact requested/terminal tool lifecycle and permission handling.
- [ ] Port refresh review, change-since-ready detection, blocked/generated path handling, secret scan, approval checks, metadata record, reject/undo, keep, and cancel.
- [ ] Port IDE target validation and short-lived shell-action authorization.
- [ ] Ensure policy denial happens before permission and permission cannot override policy.

### Required scenario tests

Run each scenario through the real host and runner with fake Veil:

- [ ] folder chat with no repository;
- [ ] git project local-mode read-only turn;
- [ ] git project local-mode edit, review, accept;
- [ ] git project local-mode edit, reject/restore;
- [ ] worktree request approve, edit, review, accept;
- [ ] worktree request deny;
- [ ] reused worktree follow-up chat;
- [ ] command permission allow and deny;
- [ ] policy denial with no permission prompt;
- [ ] stop during model stream;
- [ ] stop during child command and prove process-tree cleanup;
- [ ] host crash/restart repairs a running task to failed;
- [ ] branch dirty/conflict/refusal paths;
- [ ] attachment text/image/PDF/OCR turn;
- [ ] skill read and second tool call after history;
- [ ] split and unified review data plus line feedback;
- [ ] approval changed-since-ready, blocked file, and secret-scan failure;
- [ ] rated response telemetry and failed-tool telemetry;
- [ ] duplicate call/message ids and malformed provider events.

### Phase success state

A headless parity harness can complete all product workflows through the host without Electron or Swift. The host state/event transcript is the expected client-independent truth.

## Phase 6 — Convert Windows Electron into a thin host client first

Migrating Windows before building the full macOS UI proves that shared behavior is truly shared and avoids silently preserving TypeScript as a second backend.

### Implementation

- [ ] Add an Electron `DesktopHostSupervisor` that resolves the packaged host, passes auth through stdin, validates the handshake, connects events, and shuts down descendants.
- [ ] Add a typed `DesktopHostClient` in Electron main.
- [ ] Keep preload method names and renderer API stable; map each call to host methods.
- [ ] Keep only Windows/platform behavior in Electron main: window creation, trusted sender checks, dialogs, `safeStorage`, shell actions, context menus, renderer URL restrictions, and Windows title-bar overlay.
- [ ] Remove host-migrated imports and code from `main.ts` as each domain switches.
- [ ] Do not expose a generic `invoke(method, params)` to the renderer. Preserve explicit preload methods.
- [ ] Run the renderer unchanged against the host and compare parity scenarios.
- [ ] Once every row passes, delete the old TypeScript business implementation and its development flag.

### Tests

- existing desktop tests must be rewritten only at the ownership boundary, not weakened;
- preload remains narrow and has no generic filesystem/process/RPC primitive;
- malicious renderer inputs still fail at Electron trusted-sender and host validation;
- host crash shows recoverable UI state and does not silently start an old fallback;
- packaged resources contain executable `desktop-host`, runner, desktop-core, and Veil binaries;
- Windows process-tree cleanup uses a job object or verified `taskkill /t` fallback.

### Commands

```sh
npm --workspace @umbratic/desktop run test:all
npm run desktop:build
npm run test:all
npm --workspace @umbratic/desktop run package -- --win nsis --x64
npm --workspace @umbratic/desktop run verify:package
```

Run the Windows package and parity lane on Windows CI, not only from source inspection on macOS.

### Phase success state

Windows looks and behaves the same, but Electron main is a small platform adapter and no longer owns business, policy, persistence, process, runner, or review logic.

## Phase 7 — Create the native macOS application foundation

### Toolchain and target

- macOS deployment target: 15.0;
- Swift language mode: Swift 6 with strict concurrency;
- application identifier: preserve `ai.umbratic.desktop` unless signing ownership requires a documented change;
- distribution: Developer ID, hardened runtime, outside the Mac App Store;
- no Mac App Sandbox in this project;
- support arm64 and x86_64 using architecture-specific DMGs unless a separate support decision changes this.

Pin the Xcode version in CI. Use only Apple frameworks initially: SwiftUI, AppKit, Foundation, Observation, Security, UniformTypeIdentifiers, and os. If native CommonMark parsing needs `swift-markdown`, pin an exact reviewed release, update policy/lock evidence, and record why Apple’s built-in `AttributedString` parser was insufficient for tables/fenced blocks.

### Required entry-point scaffold

Create `UmbraticMain.swift` with this behavior:

```swift
import AppKit
import Darwin
import SwiftUI

@main
enum UmbraticMain {
    static func main() {
        if ProcessInfo.processInfo.environment["UMBRATIC_SPAWN_CHECK"] == "1" {
            print("UMBRATIC_SPAWN_OK")
            exit(EXIT_SUCCESS)
        }
        signal(SIGPIPE, SIG_IGN)
        UmbraticApp.main()
    }
}

struct UmbraticApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings { EmptyView() }
            .commands { UmbraticCommands() }
    }
}
```

The delegate owns the visible window; the empty Settings scene only anchors native commands. If a placeholder Settings window appears on a supported OS, suppress it by identifier before painting and add a UI launch test.

### AppDelegate and window behavior

- [ ] Mark `AppDelegate` `@MainActor` and conform to `NSApplicationDelegate`.
- [ ] In `applicationWillFinishLaunching`, set activation policy, opt out of unwanted snapshot restoration, and initialize redacted logging.
- [ ] In `applicationDidFinishLaunching`, start the host supervisor off the main actor, show a lightweight native launch state, and replace it with the real `AppModel` after the health handshake.
- [ ] Create an `NSWindow` through `MainWindowController` using `NSHostingController`.
- [ ] Use title-hidden transparent title bar, unified native toolbar, normal traffic lights, min size 980×680, default 1320×860, autosaved frame, and system light/dark appearance.
- [ ] Reopen/focus the main window on Dock activation.
- [ ] Use native menus: New Chat ⌘N, Open Project ⇧⌘O, Close ⌘W, Settings ⌘,, Find ⌘F when applicable, Show Review ⇧⌘R, Stop ⌘., and standard Edit/Window roles.
- [ ] Implement one reentrancy-safe bounded quit chain using `.terminateLater` and exactly one termination reply.

The essential window and shutdown shape is:

```swift
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var mainWindowController: MainWindowController?
    private var supervisor: DesktopHostSupervisor?
    private var isTerminating = false
    private var didReplyToTermination = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = MainWindowController(rootView: LaunchView())
        mainWindowController = controller
        controller.showWindow(nil)

        Task {
            do {
                let supervisor = DesktopHostSupervisor()
                self.supervisor = supervisor
                let client = try await supervisor.start()
                let model = try await AppModel.bootstrap(client: client)
                controller.setRootView(RootView(model: model))
            } catch {
                controller.setRootView(LaunchFailureView(error: PublicAppError(error)))
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !isTerminating else { return .terminateLater }
        isTerminating = true

        Task {
            await supervisor?.shutdown(gracePeriod: .seconds(8))
            replyToTerminationOnce(sender)
        }
        Task {
            try? await Task.sleep(for: .seconds(12))
            await supervisor?.forceTerminate()
            replyToTerminationOnce(sender)
        }
        return .terminateLater
    }

    private func replyToTerminationOnce(_ sender: NSApplication) {
        guard !didReplyToTermination else { return }
        didReplyToTermination = true
        sender.reply(toApplicationShouldTerminate: true)
    }
}
```

`MainWindowController` should construct the window without hidden global state:

```swift
@MainActor
final class MainWindowController: NSWindowController {
    init<Content: View>(rootView: Content) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.minSize = NSSize(width: 980, height: 680)
        window.title = "Umbratic"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.toolbarStyle = .unified
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.setFrameAutosaveName("UmbraticMainWindow")
        window.contentViewController = NSHostingController(rootView: rootView)
        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func setRootView<Content: View>(_ rootView: Content) {
        window?.contentViewController = NSHostingController(rootView: rootView)
    }
}
```

Production code must avoid racing the two shutdown tasks, keep all termination replies on the main actor, cancel the watchdog after normal completion, and surface host startup errors through stable public errors rather than `String(describing:)` on sensitive failures. The scaffold shows sequencing and ownership, not the final error model.

### Core Swift types

- `DesktopHostSupervisor` actor: launch, handshake, state, exit monitoring, graceful/forced shutdown.
- `DesktopHostClient` actor: typed RPC, timeout, auth, response validation.
- `DesktopEventStream` actor: incremental UTF-8/SSE parser, cursor persistence in memory, reconnect/backoff, authoritative refresh.
- `CredentialStore` actor/protocol: Keychain get/set/delete and test fake.
- `@MainActor @Observable AppModel`: display/selection/presentation state only.
- `PresentationCoordinator`: serializes permission, destructive, attachment, and credential prompts.
- public `Codable` models generated or manually matched to checked-in fixtures; unknown enum values fail closed into a visible protocol error.

### Keychain implementation contract

Use `Security.framework` directly:

- class: `kSecClassGenericPassword`;
- service: `ai.umbratic.desktop.model-endpoint`;
- account: `default`;
- accessibility: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` unless product requirements demand a stricter user-presence policy;
- update existing items with `SecItemUpdate`, create with `SecItemAdd`, fetch with `SecItemCopyMatching`, remove with `SecItemDelete`;
- never log `OSStatus` together with secret data;
- translate expected not-found and interaction-not-allowed states into stable app errors;
- unit test via an injected protocol, and run a signed manual Keychain round trip.

### Tests and commands

```sh
swift test --package-path apps/macos/Packages/UmbraticMacCore
xcodebuild \
  -project apps/macos/App/Umbratic.xcodeproj \
  -scheme Umbratic \
  -configuration Debug \
  -destination 'platform=macOS' \
  build
xcodebuild \
  -project apps/macos/App/Umbratic.xcodeproj \
  -scheme Umbratic \
  -destination 'platform=macOS' \
  test
```

### Phase success state

The native app launches, starts and authenticates to the real host, shows host health, reconnects after an event-stream interruption, applies native appearance, and quits without any surviving host child. No product feature UI is claimed complete yet.

## Phase 8 — Implement native UI parity in vertical slices

Build and verify each slice end to end against the real host before starting the next. Do not build a large mock-only UI and connect it at the end.

### 8A. Main layout, projects, chats, and drafts

- [ ] Native toolbar and three-pane split layout.
- [ ] Project → worktree → chat hierarchy with collapse, selection, new chat/project, and delete confirmations.
- [ ] Empty/loading/error/retry states.
- [ ] Draft and selected chat persistence through host.
- [ ] Settings entry and “Private and Confidential” product marking.
- [ ] Keyboard traversal and VoiceOver hierarchy.

Use a native `NSSplitView` wrapper for pane sizes and divider keyboard actions. Start the hierarchy with SwiftUI `OutlineGroup`; replace it with `NSOutlineView` only if the saved performance/accessibility proof fails.

### 8B. Native timeline

Implement an `NSTableView` through `NSViewRepresentable`:

- stable row ids from event/task models;
- reusable row views for user, assistant, reasoning, activity/tool, permission, approval, error, and context states;
- TextKit selectable text, copy actions, links restricted to authorized app actions;
- native markdown renderer that never interprets raw HTML or script;
- headings, paragraphs, emphasis, links, inline code, fenced code, lists, blockquotes, tables, unfinished fences, and escaped content;
- code blocks with copy, horizontal scroll, monospaced font, and language label;
- batched streaming updates with no display backlog;
- expanded/collapsed tool/reasoning state keyed by stable ids;
- scroll pinning only when the user is near the bottom; do not steal position after manual scroll;
- cached row heights keyed by content revision, width, font scale, and appearance.

Match copy, good/bad response rating, optional feedback note, review reference, and streaming behavior.

### 8C. Composer and attachments

- [ ] AppKit-backed multiline `NSTextView` with native undo, selection, dictation, IME, paste, and drag/drop.
- [ ] File `@` and skill completion with keyboard selection and no email false positive.
- [ ] Attachment picker, paste data, chips, previews, open, and removal.
- [ ] Review feedback references shown separately from visible prompt text.
- [ ] Context meter hidden/normal/warning/critical states from host values.
- [ ] Workspace local/worktree, reasoning/fast, permission mode, branch, IDE, send, and stop controls.
- [ ] Draft restoration after cancellation or failed connection.
- [ ] Pending worktree and command permission sheets coordinated so only one blocking prompt is visible.

### 8D. Native review

- [ ] Resizable review pane and changed-file navigator with totals/status.
- [ ] Turn changes and whole-diff scope.
- [ ] Split and unified layouts.
- [ ] Wrap toggle, binary/too-large/no-diff states, old path for rename, open in IDE.
- [ ] AppKit reusable diff rows with add/remove/context background, line numbers, intra-line spans, selectable/copyable code, and height cache.
- [ ] Feedback mode, discontinuous line selection, editor, deterministic structured comment payload, stale comment state, and feedback preview.
- [ ] Accept/reject/undo, approval-check progress, changed-since-ready, and failure states.

Clients render canonical aligned rows from the host. They must not independently parse patches or serialize the model-facing feedback suffix.

### 8E. Settings, skills, diagnostics, and telemetry

- [ ] Connection mode/software/base URL/model/header/secret form with credential-required state.
- [ ] Harness profile and context length.
- [ ] Appearance: system/light/dark, UI and monospace font selection, font scale, reduced motion.
- [ ] Skill system/personal filter, enable toggles, create/import/edit/save/reset/open.
- [ ] Capability status and refresh.
- [ ] Telemetry explanation/export and local diagnostic export/clear/open folder.
- [ ] Native save panels and scoped host export-copy flow.

### Automated UI state mode

Add launch arguments that connect the app to a deterministic fake host or load signed fixture snapshots. Required states must be reachable without a live model:

- empty and populated sidebar;
- long chat titles and paths;
- streamed assistant and reasoning;
- tool running/success/failure;
- permission and worktree approval;
- attachment preview;
- review split/unified/comment/accept/reject;
- each settings tab;
- host disconnected/protocol mismatch/credential required;
- light/dark, reduced motion, and minimum window size.

This mode must never exist in Release unless gated by a signed test-only entitlement or compile configuration.

### Phase success state

Every UI and operation parity row is `PASS` on macOS with a linked test or screenshot/video. A user can complete the same end-to-end workflows as Windows without web content.

## Phase 9 — Data upgrade and credential transition

### Implementation

- [ ] Confirm native and Electron application-support paths on real macOS accounts.
- [ ] Test current Electron databases copied into a clean native profile.
- [ ] Preserve bundle identifier/app name path behavior or implement a one-time atomic copy with collision rules.
- [ ] Add a final Electron-mac transition release that reads its existing `safeStorage` secret and writes the new Keychain item through a signed native helper or agreed bridge.
- [ ] Native first launch checks Keychain. If DB says `secretConfigured` but no item exists, show “Re-enter server credential”; do not reset URL/model/headers.
- [ ] Record a non-sensitive migration-completed version so it is idempotent.
- [ ] Test local-mode users, server-mode users with migrated secret, skipped-transition users, empty profiles, legacy app-name paths, malformed DB, and missing Keychain access.

### Verify

- Chats/projects/tasks/notes/settings/skills open with identical public values before and after upgrade.
- No plaintext secret appears in SQLite, plist defaults, logs, environment dumps, crash reports, or export artifacts.
- Failed migrations leave the original DB and Keychain item intact and provide recovery instructions.
- Downgrade during the rollback window can still read the pre-migration backup or a documented compatible schema.

### Phase success state

Existing users upgrade without data loss; server users either migrate transparently or re-enter only the secret with a clear explanation.

## Phase 10 — Native packaging, signing, notarization, and CI

### Sidecar build

For each macOS architecture:

- [ ] build `umbratic-desktop-host`, `umbratic-runner`, and `umbratic-desktop-core` with `cargo build --locked --release --target <arch>-apple-darwin`;
- [ ] build Veil from the same Go module with `GOOS=darwin` and the matching `GOARCH`;
- [ ] copy only the exact binaries and system skills into `Contents/Resources`;
- [ ] strip only according to approved release settings; do not destroy crash symbol archives;
- [ ] write a bundle manifest with filename, version, architecture, size, and SHA-256;
- [ ] reject symlinks, unexpected writable/executable resources, duplicate binaries, and missing execute bits.

### Signing order

1. sign each nested sidecar with Developer ID Application and hardened runtime;
2. sign embedded frameworks/packages if any;
3. sign the main app last;
4. verify deep and strict signatures without using `--deep` as a substitute for correct signing order;
5. create the DMG;
6. sign the DMG;
7. submit for notarization, wait, staple app/DMG as appropriate;
8. run `spctl --assess` on a clean copy.

Do not add `allow-jit`, `disable-library-validation`, unsigned executable memory, or broad Apple-events entitlements unless a concrete feature requires it and the security impact is documented.

### Bundle verification

`verify-bundle.sh` must assert:

- Info.plist identifier, versions, minimum OS, category, and icon;
- expected architectures with `lipo -info` or `file`;
- exact manifest hashes and executable bits;
- codesign validity for every Mach-O and the outer app;
- spawn sentinels for app and host;
- host can launch packaged runner, desktop-core, and Veil from resource paths;
- no Electron, Chromium, Node, `.asar`, `dist-electron`, preload, or renderer HTML/JS;
- no source `.env`, secret, development URL, test fixture, or private signing file;
- app launches from a path containing spaces and from a mounted read-only DMG;
- quit leaves no descendant process.

### CI split

Replace the macOS Electron matrix row with:

- `verify-shared`: Linux or supported runner; Rust/Go/Node contracts and tests;
- `package-windows`: Windows; Electron NSIS x64 and full Windows parity;
- `test-macos`: macOS; Swift tests, Xcode tests, host/runner integration, accessibility smoke;
- `package-macos-arm64`: signed/notarized native artifact when credentials are present;
- `package-macos-x86_64`: native artifact on a suitable builder/cross-build lane;
- `publish-release`: attaches Windows and both macOS architecture assets after all required jobs.

Pin every GitHub Action to the exact immutable version required by existing policy. Keep release write permission only where publication needs it.

### Commands

```sh
npm run test:all
cargo fmt --all -- --check
cargo test --locked --workspace --all-targets
cargo clippy --locked --workspace --all-targets -- -D warnings
swift test --package-path apps/macos/Packages/UmbraticMacCore
xcodebuild -project apps/macos/App/Umbratic.xcodeproj -scheme Umbratic -destination 'platform=macOS' test
apps/macos/scripts/build-sidecars.sh
apps/macos/scripts/verify-bundle.sh /absolute/path/to/Umbratic.app
apps/macos/scripts/package-dmg.sh
```

### Phase success state

A clean Mac can mount the notarized DMG, pass Gatekeeper, launch the native app and sidecars, complete a fake-Veil task, quit cleanly, and relaunch with preserved state. Windows NSIS still passes its existing package verification.

## Phase 11 — Performance, security, accessibility, and release proof

### Performance benchmark

Run the exact `PERF-L1` through `PERF-Q1` workloads defined in [[#Required before-and-after performance protocol]] against the packaged native application. Do not substitute a development build, reduce fixture size, shorten idle duration, or exclude a slow sample.

- [ ] Save native raw results to `reports/performance/native-macos-migration/final/native-macos.json`.
- [ ] Generate `comparison.json` from the saved packaged Electron and packaged native reports.
- [ ] Save representative Instruments Time Profiler, Hangs, and Energy Log traces for `PERF-I1`, `PERF-C1`, `PERF-S1`, and `PERF-R1`.
- [ ] Attribute CPU, memory, wakeups, and disk use to the app, desktop host, runner, desktop-core, Veil, and model service separately.
- [ ] Run real-model measurements as a separate appendix with model id, context, prompt, and runtime settings; do not use them for shell pass/fail comparisons.
- [ ] Investigate monotonic memory/disk growth and persistent idle activity even when the final point remains below an absolute ceiling.

### Performance success gates

Use the Phase 0 packaged Electron result for relative comparisons. The checked-in 1,488.86 MB Electron RSS and 138 MB DMG remain historical cross-checks, not replacements for the new baseline.

#### Launch and opening

- [ ] `PERF-L1` process-start → interactive median ≤ 600 ms, p95 ≤ 900 ms, and median at least 40% faster than packaged Electron.
- [ ] `PERF-L2` populated-profile process-start → timeline-visible median ≤ 900 ms, p95 ≤ 1,200 ms, and median at least 30% faster than packaged Electron.
- [ ] `PERF-L3` warm relaunch does not regress from the native populated-profile launch by more than 10%.
- [ ] Opening the 500-item conversation after launch has median latency ≤ 200 ms and p95 ≤ 350 ms.
- [ ] Opening the 20-file/5,000-line review has median latency ≤ 300 ms and p95 ≤ 500 ms.
- [ ] Host-ready, first-frame, interactive, and content-visible markers occur in order and are emitted exactly once per launch.

#### RAM and memory behavior

- [ ] `PERF-I1` native app + idle desktop-host aggregate physical footprint ≤ 200 MB after settling.
- [ ] `PERF-I1` native app + idle desktop-host summed RSS ≤ 250 MB and is at least 75% below the packaged Electron baseline.
- [ ] No runner, desktop-core, Veil, or model process remains resident during the idle-shell measurement.
- [ ] `PERF-T1` app + host + runner + Veil aggregate physical footprint ≤ 350 MB when using the deterministic fake model; model-runtime memory is reported separately.
- [ ] Runner cold start, idle RSS, and warm RSS do not regress by more than 20% from the checked-in runner baseline without an explicitly accepted technical reason.
- [ ] After `PERF-C1` and `PERF-R1` are repeated 20 times and the app sits idle for 60 seconds, physical footprint returns to within the greater of 10% or 25 MB of the pre-workload value.
- [ ] Five-minute idle memory has no sustained positive slope after the settling period; retained growth must be attributed to a bounded cache with a tested limit.

#### CPU, wakeups, and energy

- [ ] During `PERF-I1`, app + host combined CPU averages ≤ 1% of one logical core and p95 ≤ 3% after settling.
- [ ] Five-minute idle CPU seconds are at least 70% lower than packaged Electron.
- [ ] Launch CPU seconds through interactive are at least 30% lower than packaged Electron for `PERF-L1` and `PERF-L2`.
- [ ] `PERF-S1` and `PERF-R1` process-tree CPU seconds are at least 30% lower than packaged Electron for the identical fixture and action sequence.
- [ ] Idle wakeups average ≤ 10 per second across the app and host, with no polling timer firing more often than once per second when no work is active.
- [ ] Instruments Energy Log shows no sustained high-energy state during idle; any medium/high interval during streaming is tied to an active bounded workload and returns to low after completion.

#### Disk and installed size

- [ ] Native architecture-specific DMG is at least 50% smaller than the 138 MB historical Electron DMG and at least 50% smaller than the newly measured packaged Electron DMG.
- [ ] Installed native `.app` is at least 60% smaller than the packaged Electron `.app` for the same architecture.
- [ ] Bundle reporting separates the main executable, Swift/runtime content, desktop host, runner, desktop-core, Veil, system skills, assets, and signature overhead.
- [ ] A clean first launch creates no more than 15 MB of application-support/cache/log data before the user starts a task.
- [ ] Ten normal idle relaunches add no more than 5 MB of cache/log/temp data in total.
- [ ] `PERF-D1` accounts for every retained directory and file category; abandoned attachment, OCR, PDF-render, diagnostic-export, or sidecar temporary files are a failure.
- [ ] User-authored chat/task data grows only in proportion to the fixed fixture payload and is not duplicated on each read or relaunch.

#### Responsiveness, streaming, and cleanup

- [ ] `PERF-C1` and `PERF-R1` have no main-thread hang longer than 100 ms in Instruments during ordinary interaction.
- [ ] `PERF-S1` host-delivery → visible-event latency median ≤ 33 ms and p95 ≤ 100 ms.
- [ ] The terminal event is visible within 100 ms of host delivery and the render queue returns to zero.
- [ ] Streaming produces no dropped terminal events, unbounded render queue, or increasing lag between received and visible sequence ids.
- [ ] File-search p95 ≤ 50 ms with the same result checksum and no more than 20% CPU-time regression.
- [ ] Idle native process count is exactly two: the app and desktop host.
- [ ] `PERF-Q1` leaves zero descendant processes within five seconds after quit in every tested state.

If a gate fails, save the failing raw data and trace, identify the owning process/function, make the improvement, and rerun the entire affected workload group. A local fast run or a reduced fixture does not replace the required comparison.

### Security review

- [ ] hostile RPC/body/auth/path tests pass;
- [ ] UI cannot invoke an undeclared host method;
- [ ] renderer and Swift state never contain host/runner/Veil auth secrets;
- [ ] absolute paths and secrets are absent from diagnostic exports;
- [ ] policy denial precedes permission;
- [ ] symlink/traversal/secret/generated paths fail at host and runner boundaries;
- [ ] runner binds loopback and requires auth unchanged;
- [ ] model traffic observed only between runner and Veil and Veil to approved runtime;
- [ ] app, host, runner, desktop-core, and Veil signatures verify;
- [ ] no orphan on normal quit, force-close window, host crash, runner crash, or update request.

### Accessibility and native UX review

- [ ] complete keyboard-only new chat → prompt → permission → review → accept workflow;
- [ ] VoiceOver names, values, groups, selected state, expanded state, and live announcements;
- [ ] minimum 4.5:1 text contrast or documented large-text exception;
- [ ] system/light/dark and increased contrast;
- [ ] reduced motion;
- [ ] keyboard focus never trapped behind a sheet;
- [ ] Escape dismisses only the top safe-to-dismiss presentation;
- [ ] destructive default button is never focused accidentally;
- [ ] font scaling and long localized strings do not clip;
- [ ] minimum window and side-by-side tiling layouts work;
- [ ] text, code, diffs, and paths can be selected/copied where expected.

### Full final test run

```sh
npm run test:all
npm run desktop:build
cargo fmt --all -- --check
cargo test --locked --workspace --all-targets
cargo clippy --locked --workspace --all-targets -- -D warnings
npm --workspace @umbratic/runner run test:all
npm run veil:test
swift test --package-path apps/macos/Packages/UmbraticMacCore
xcodebuild -project apps/macos/App/Umbratic.xcodeproj -scheme Umbratic -destination 'platform=macOS' test
npm --workspace @umbratic/desktop run package -- --win nsis --x64
npm --workspace @umbratic/desktop run verify:package
apps/macos/scripts/build-sidecars.sh
apps/macos/scripts/verify-bundle.sh /absolute/path/to/Umbratic.app
apps/macos/scripts/benchmark-macos.sh \
  --artifact /absolute/path/to/native/Umbratic.app \
  --fixture /absolute/path/to/performance-fixture \
  --output reports/performance/native-macos-migration/final/native-macos.json
node scripts/compare-desktop-performance.ts \
  --baseline reports/performance/native-macos-migration/baseline/electron-macos.json \
  --final reports/performance/native-macos-migration/final/native-macos.json \
  --output reports/performance/native-macos-migration/comparison.json
node scripts/verify-desktop-parity.ts
```

### Phase success state

All gates pass and the evidence report links test logs, parity results, screenshots, Instruments traces, raw baseline/final benchmark JSON, the comparison report, bundle manifest, signature verification, notarization id, and known limitations. The report demonstrates improved launch, memory, CPU, disk, and responsiveness results using the same workloads. “Looks correct locally” is not release evidence.

## Phase 12 — Rollout, rollback, and removal of macOS Electron

### Rollout

- [ ] Release first to internal users with both local and server modes represented.
- [ ] Monitor only redacted launch failure, host crash, child orphan, migration result, task terminal state, and performance counters already allowed by telemetry policy.
- [ ] Keep the last macOS Electron DMG available during the rollback window.
- [ ] Use schema-compatible migrations or preserve an automatic pre-migration backup.
- [ ] Expand rollout only after no critical data, credential, runner, review, or process-lifecycle issue is open.

### Rollback triggers

Rollback the macOS release for:

- data loss or unrecoverable schema migration;
- credential loss without the re-entry fallback;
- policy/permission bypass;
- runner/Veil direct-runtime boundary violation;
- repeatable orphan child process after quit;
- missing terminal events that can leave a task ambiguous;
- notarization/Gatekeeper failure on supported macOS;
- a parity-critical workflow unavailable without a safe workaround.

### Removal

After the rollback window:

- [ ] remove macOS targets from `electron-builder.yml`;
- [ ] rename Electron scripts and docs to make Windows-only scope explicit;
- [ ] delete macOS-specific Electron branches and assets only when no longer shared with Windows;
- [ ] remove transition-only credential migration code after its documented support period;
- [ ] update README architecture/install/release instructions;
- [ ] archive final Electron and first native benchmark evidence;
- [ ] mark every parity row `PASS` or explicitly accepted `N/A` with owner and rationale.

### Final success state

Native macOS is the supported Mac distribution, Electron is Windows-only, shared behavior has one Rust implementation, rollback artifacts are no longer needed, and the evidence registry is complete.

## Required evidence report format

Create `reports/native-macos-release-evidence-YYYY-MM-DD.md` with:

1. build identifier, product/tool versions, OS/hardware, and architecture;
2. scope and unresolved limitations;
3. parity-ledger totals and link;
4. exact commands with exit status;
5. test artifact paths;
6. manual scenario table with tester/date/result;
7. screenshots for required light/dark and failure states;
8. performance comparison table covering launch, RSS, physical footprint, CPU, wakeups/energy, process count, responsiveness, installed/DMG/user-data disk usage, cleanup, and raw JSON/Instruments links;
9. child-process cleanup proof;
10. database and credential migration proof;
11. bundle manifest and sizes;
12. codesign, Gatekeeper, notarization, and staple proof;
13. security review results;
14. accessibility results;
15. rollout/rollback decision and approver.

Rows with missing evidence remain `UNPROVEN`; they do not become `PASS` because another nearby test passed.
