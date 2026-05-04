---
tags: [ai-project, mvp, desktop, local-first, opencode, aegis-runner, worktree, privacy, telemetry, lm-studio]
status: draft
updated: 2026-05-04
---

# Aegis MVP Implementation Plan

Aegis is a **local-first desktop coding-agent app**. The MVP should prove that a developer can run useful code tasks on their own machine with local repository control, local model access, visible tool activity, manual review, and explicit approval.

The current implementation is already an Electron desktop app under `desktop/`. This plan starts from that reality rather than from an abstract CLI or WarpUI plan.

## Product goal

Build one trustworthy local developer loop:

```text
select folder or repo
  -> ask Aegis for a coding change or codebase answer
  -> run the Aegis-controlled OpenCode foundation locally
  -> show reasoning, tool actions, permissions, changed files, and diff
  -> open the review workspace in an editor
  -> approve, merge, undo, or keep the workspace
  -> record local telemetry for debugging and product learning
```

For the MVP, Aegis should run locally and use a local OpenAI-compatible model endpoint, currently LM Studio at `http://127.0.0.1:1234/v1`. Server-hosted models, telemetry sync, admin policy, remote workers, and central dashboards belong in the post-MVP implementation plan.

For the MVP, Aegis should **not fork OpenCode yet**. The practical approach is to harden the packaged OpenCode integration as much as possible from the outside: strict config generation, localhost-only server binding, provider allowlists, denied web tools, empty MCP/plugin lists, Aegis-owned permission handling, runtime policies, local review, and final approval checks. A dedicated future plan covers the eventual fork/strip path: [[Future_OpenCode_Fork_Plan]].

## Current baseline

The repo currently contains:

- Electron + React + Vite desktop app in `desktop/`.
- Hardened Electron shell with `contextIsolation`, renderer sandboxing, `nodeIntegration: false`, strict CSP, blocked navigation, denied permission requests, and IPC sender validation.
- Typed preload API in `desktop/src/preload/preload.ts`.
- Main-process ownership of filesystem, Git, shell/process execution, OpenCode, folder selection, model probing, IDE handoff, approval, merge, cleanup, and local storage.
- OpenCode installed through npm and launched as a local server with `opencode serve --pure --hostname=127.0.0.1`.
- Per-task OpenCode config injected through `OPENCODE_CONFIG_CONTENT`.
- OpenCode event streaming through SSE, mapped into Aegis events like assistant text, reasoning text, command starts/output/finish, permission requests, review readiness, approval checks, and merge completion.
- LM Studio model probing through `http://127.0.0.1:1234/api/v0/models`, with selected model persisted in settings.
- Local provider lockdown to `local-lmstudio`; public providers are disabled, web fetch/search are denied, share is disabled, and auto-update is disabled.
- Normal and bypass permission modes. Bypass allows local edit/bash tool actions but still keeps web tools denied and final merge manual.
- Git worktree support for mutating Git tasks, using `~/.aegis/worktrees/...`.
- Folder-mode support using a baseline snapshot for non-Git folders or unattached chats.
- Review panel with changed files, unified diff rows, IDE/file-manager open, approval checks, Accept + merge, and undo/reject flows.
- Chat archive, project grouping, prompt drafts, `@file` attachment search, Think mode, model picker, repository picker, and command/reasoning timeline.
- Python runtime policy injected into OpenCode and runtime environment, including a `uv`-first `.venv` workflow and denial of bare `python`, `python3`, or `py` verification commands.
- Local JSON storage in Electron user data: `projects.json`, `tasks.json`, `chats.json`, `settings.json`, plus task metadata JSON.

That is enough to call the current app an Aegis prototype, not merely an OpenCode launcher. The MVP work should deepen the Aegis-owned control plane around OpenCode.

## MVP scope

The MVP should include:

- Local desktop app as the primary interface.
- Local model provider settings for LM Studio.
- Optional local profile or enterprise SSO identity section in Settings.
- Repository/folder selection and recent-project recall.
- Chat/task workflow with file attachments and visible tool activity.
- Git worktree creation for mutating Git tasks.
- Snapshot-based review for regular folders.
- Permission prompts for worktree creation, edit tools, and shell tools.
- Bypass mode with clear settings and non-bypassable final approval.
- Review panel with changed files, diff, open-in-editor, accept, undo, and keep options.
- Local telemetry/event ledger with export.
- Robust Aegis runtime policies for Python, Markdown, C/C++ with CMake, PowerShell, and Linux/macOS shell commands.
- A clearer Aegis Runner abstraction over the current OpenCode server integration.
- OpenCode package hardening without forking: generated config assertions, environment flags where supported, egress visibility, and tests that fail if public providers/web tools/plugins/MCP/sharing are re-enabled.

## Non-goals

- No server-hosted model requirement for MVP.
- No server-side Git clone or server-side worktree.
- No remote agent runner.
- No central admin dashboard.
- No telemetry sync by default.
- No IDE plugin.
- No public model provider marketplace.
- No public provider API keys.
- No automatic upload of code, prompts, diffs, command output, or transcripts.
- No broad enterprise policy engine yet.

## Architecture

The MVP architecture is local:

```text
Electron renderer
  untrusted UI
  calls narrow preload API only

Electron preload
  typed Aegis bridge

Electron main process
  trusted local control plane
  owns Git, filesystem, shell, OpenCode, storage, settings, approvals, IDE handoff

Aegis Runner layer
  wraps OpenCode server today
  emits Aegis task/tool/review events
  enforces Aegis policies before and after OpenCode actions

OpenCode foundation
  local agent loop, tools, permissions, SSE events
  configured for one local provider

Local model endpoint
  LM Studio for MVP
  OpenAI-compatible localhost URL

Local storage
  JSON for app state where simple
  SQLite for MVP telemetry/event data
```

The important product boundary is:

```text
OpenCode supplies agent/tool mechanics.
Aegis owns task state, workspace boundaries, provider policy, runtime policy,
telemetry, review, approval, merge, undo, and settings.
```

## OpenCode to Aegis Runner

OpenCode should remain the implementation foundation for the MVP, but the product should stop presenting the core as "just OpenCode." The next implementation layer should be an Aegis Runner contract that can wrap OpenCode now and later replace or fork parts of it.

For the MVP, OpenCode is a dependency package. Aegis should not edit OpenCode source directly, and should not block MVP progress on a fork. The MVP work is to make the package behave inside Aegis constraints.

### Current OpenCode integration

The current harness already:

- Finds the bundled OpenCode binary.
- Starts a localhost OpenCode server per task.
- Generates a locked config with one provider.
- Sets a per-run password.
- Reads OpenCode SSE events.
- Sends prompt requests through OpenCode's HTTP API.
- Replies to OpenCode permission requests.
- Converts OpenCode tool/message events into Aegis UI events.
- Stops runs on completion, cancel, quit, or failure.

### MVP Aegis Runner contract

Add an explicit internal runner boundary:

```ts
type AegisRunner = {
  start(task: TaskRecord, prompt: string): Promise<RunnerSession>;
  sendFeedback(session: RunnerSession, feedback: string): Promise<void>;
  cancel(session: RunnerSession): Promise<void>;
};

type RunnerEvent =
  | "assistant.delta"
  | "assistant.reasoning.delta"
  | "tool.requested"
  | "tool.output"
  | "tool.finished"
  | "permission.requested"
  | "review.ready"
  | "runner.error";
```

This contract should be Aegis-native even if the first adapter is `OpenCodeRunner`. It should hide OpenCode-specific route names, event schemas, permission reply shapes, and server startup details from the rest of the app.

### MVP hardening

Move from prompt-only policy to Aegis-owned checks:

- Generate OpenCode config in Aegis and assert it contains exactly the approved local provider.
- Start OpenCode only on `127.0.0.1` with a per-run password.
- Keep `share: "disabled"`, `autoupdate: false`, `mcp: {}`, `plugin: []`, and `instructions: []`.
- Keep public providers in `disabled_providers`.
- Use OpenCode environment flags for disabling update/model-fetch/share/web behavior whenever available.
- Preflight task policy before OpenCode starts.
- Normalize all workspace paths before tool approval.
- Deny generated runtime paths from review and approval.
- Deny blocked secret paths from approval.
- Track tool command class: read, edit, shell, package install, network, external directory.
- Deny web fetch/search and public provider routes.
- Detect bare Python verification commands and deny them, already started.
- Add command classifiers for PowerShell, POSIX shell, CMake, compilers, package managers, and destructive Git/file operations.
- Persist runner version, model, provider, policy version, and runtime profile on every task.
- Add regression tests around generated OpenCode config so future edits cannot silently re-enable public providers, web search/fetch, plugins, MCP, sharing, or auto-update.
- Add egress visibility for the OpenCode process: log intended network destinations locally and warn if any non-localhost destination is observed or configured.

### Post-MVP fork/strip path

After the MVP loop proves useful, fork or replace OpenCode pieces behind the Aegis Runner contract. The detailed future plan is in [[Future_OpenCode_Fork_Plan]].

## Language and runtime robustness

The MVP should make Aegis feel reliable on common local development tasks, not merely dependent on whatever OpenCode chooses to do.

### Python

Current state:

- A Python runtime policy exists in `desktop/src/main/config.ts`.
- Python prompts receive extra runtime instructions.
- The OpenCode system prompt always includes the Python policy.
- The runtime env points `uv` installs and caches into `.aegis/runtime`.
- Bare `python`, `python3`, and `py` verification commands are denied.

MVP work:

- Add a Python runtime detector that records `uv`, `.venv`, `pyproject.toml`, `requirements.txt`, and package manager state.
- Create a reusable Python task profile in Aegis, not only a prompt string.
- Summarize Python runtime attempts in telemetry: command class, exit code, short error, duration.
- Prefer `uv run`, `.venv` interpreter, and `pytest` through the managed env.
- Treat created `.venv`, `__pycache__`, `.pyc`, and `.aegis/runtime` as generated runtime paths.
- Add a local test fixture for a simple Python script plus one package dependency.

### Markdown

MVP work:

- Treat `.md`, `.markdown`, and docs-only changes as first-class safe edit tasks.
- Add Markdown-aware review summaries: changed headings, added/removed sections, broken local links if cheaply detectable.
- Avoid running shell commands for pure docs tasks unless linting is configured.
- If `markdownlint` or repo docs scripts exist, suggest or run them through the normal permission path.
- Preserve frontmatter and line endings.
- Keep generated docs assets out of telemetry by default.

### C/C++ and CMake

MVP work:

- Detect `CMakeLists.txt`, `CMakePresets.json`, `CTestTestfile.cmake`, `compile_commands.json`, `src/`, `include/`, and common test folders.
- Add an Aegis CMake runtime profile:

```text
cmake -S . -B .aegis/build
cmake --build .aegis/build
ctest --test-dir .aegis/build --output-on-failure
```

- Use an out-of-source build directory inside the task workspace.
- Treat `.aegis/build`, `build/`, generated binaries, object files, and compiler databases as generated unless the repo intentionally tracks them.
- Detect compiler/tool availability: `cmake`, `ninja`, `make`, `clang`, `gcc`, `cl`, `ctest`.
- On Windows, account for Visual Studio generator paths where available.
- Add command classifiers for build commands and package/install commands.
- Require approval before package manager installs or system-level compiler changes.

### PowerShell

MVP work:

- Prefer `pwsh` when available, otherwise Windows PowerShell.
- Run commands with `-NoProfile -NonInteractive`.
- Capture command, cwd, exit code, stdout/stderr tail, and duration.
- Deny or require explicit approval for destructive commands outside the workspace.
- Treat environment dumps, secret-like output, and credential paths as redaction candidates.
- Add a shell policy that avoids shell-string composition for file moves/deletes when Aegis can use structured filesystem APIs.

### Linux and macOS shell

MVP work:

- Detect platform shell and toolchain availability.
- Use workspace-scoped commands by default.
- Deny `sudo`, system package managers, external-directory writes, and global config edits unless explicitly approved.
- Capture process tree enough to know the command class and duration.
- Add known safe command profiles for `npm test`, `npm run`, `pytest`, `uv`, `cmake`, `ctest`, `cargo test`, and basic Git read-only commands.

## Settings page

The renderer currently has a Settings placeholder. The MVP should turn it into a real settings surface.

### Account

Include account settings in MVP, but do not make them a hard requirement for local use.

- Local profile mode: display name and optional work email stored locally.
- Optional enterprise SSO: Microsoft Entra ID or Google Workspace via OIDC when configured.
- Browser-based sign-in flow, returning only identity/session metadata to Aegis.
- Tokens stored in the OS credential store if available, not in plain JSON.
- Sign-in state used for display, future policy sync, and future telemetry attribution.
- Local task execution must keep working without sign-in for MVP development builds.

This gives the product an enterprise shape without turning the MVP into a server project.

### Models

- LM Studio base URL, defaulting to `http://127.0.0.1:1234/v1`.
- Model list refresh.
- Selected model.
- Provider status and last probe error.
- Future server endpoint fields can be present behind an advanced/deferred flag, but the MVP supported provider is local.

### Permissions

- Normal vs bypass mode.
- Default edit and shell behavior.
- Always-denied web tools.
- External directory policy.
- Final approval reminder.
- Per-task permission history.

### Runtimes

- Python runtime policy status: `uv`, `.venv`, Python version.
- CMake/C++ toolchain detection.
- Shell profile: PowerShell, POSIX shell, command timeout.
- Generated path rules.
- Optional repo-local `aegis.yaml` policy preview.

### Privacy and telemetry

- Telemetry policy status: local-only MVP, enterprise-managed later.
- Local telemetry on/off when the product is in individual/development mode.
- Organization policy indicator when telemetry is company-managed and the developer cannot disable it locally.
- Retention period.
- Export task bundle.
- Clear local task/chat history.
- Show exactly what is stored locally.
- State clearly that sync is not part of MVP.

### Editors

Current implementation detects VS Code, Visual Studio, and file manager/Finder/Explorer. MVP should add:

- Preferred editor selection.
- Cursor, Windsurf, and JetBrains detection where command-line launchers are available.
- Open changed file vs open whole review workspace preference.

### Diagnostics

- OpenCode binary status.
- LM Studio status.
- Current provider allowlist.
- Disabled public providers.
- Last runner error.
- App version, runner version, policy version.

## Telemetry and learning loop

Telemetry should stay in the product, but MVP telemetry is local-only.

The MVP should prove the telemetry pipeline works by writing events to a local database, showing a basic telemetry/settings view, and supporting export. Whether the developer can disable telemetry is a policy question:

- Individual/local development mode: developer can toggle local telemetry off.
- Company-managed mode: telemetry behavior is controlled by organization policy. If the company requires telemetry for model improvement, audit, safety, or support, the Settings UI should show that it is managed and not locally editable.
- Privacy-sensitive company mode: organization policy can disable telemetry globally, and the local app should show telemetry as disabled by policy.

In every MVP mode, telemetry is local-only unless a later server implementation explicitly adds sync.

### Current event foundation

The app already records task events in memory and persists task records. Existing event types include:

- user message
- assistant text and reasoning deltas
- worktree requested/created
- command started/output/finished
- permission requested/resolved
- review ready
- approval check
- merge completed
- task error

### MVP telemetry goals

Use telemetry as a local debug and learning ledger:

- Understand what tasks succeed or fail locally.
- See which runtime policies need improvement.
- Debug OpenCode/Aegis runner errors.
- Support explicit export for a developer-controlled support bundle.
- Prepare a clean schema for later enterprise sync.

### MVP telemetry fields

Capture locally:

- Task id, chat id, repo id, workspace kind.
- Base branch, base commit, agent branch, worktree path hash.
- Model provider id, model id, base URL host, runner version, policy version.
- Permission mode and reasoning mode.
- Event timestamps and durations.
- Tool kind and command class.
- Command exit code and truncated/redacted output summary.
- Changed file paths, statuses, diff stats, and patch hash.
- Approval check names, results, and short details.
- Runtime profile attempts for Python, Markdown, CMake, PowerShell, and POSIX shell.
- Error category and short message.

Do not sync or export by default:

- Raw source code.
- Full prompts.
- Full diffs.
- Full command output.
- Secrets or environment variables.
- Unredacted file contents.

The local app may keep prompt/chat history for product functionality, but telemetry export should redact or omit prompt bodies unless the user explicitly chooses a debug bundle that includes them.

### Storage

Keep JSON for simple app state if it remains convenient: chats, recent projects, and basic settings. Use SQLite for telemetry so events can be queried, retained, exported, and eventually synced without inventing a second data model.

Default path:

```text
<Electron userData>/aegis-telemetry.sqlite
```

Minimum MVP schema:

```sql
create table schema_migrations (
  version integer primary key,
  applied_at text not null
);

create table telemetry_policy (
  id integer primary key check (id = 1),
  mode text not null check (mode in ('developer_toggle', 'managed_required', 'managed_disabled')),
  local_enabled integer not null check (local_enabled in (0, 1)),
  sync_enabled integer not null check (sync_enabled = 0),
  retention_days integer not null default 30,
  updated_at text not null
);

create table task_runs (
  id text primary key,
  chat_id text,
  repo_id text,
  repo_root_hash text,
  workspace_kind text not null,
  base_branch text,
  base_commit text,
  agent_branch text,
  worktree_path_hash text,
  provider_id text,
  model_id text,
  model_base_url_host text,
  runner_name text not null,
  runner_version text,
  policy_version text not null,
  permission_mode text not null,
  reasoning_mode text,
  status text not null,
  started_at text not null,
  completed_at text,
  error_category text,
  error_message text
);

create table task_events (
  id integer primary key autoincrement,
  task_id text not null references task_runs(id) on delete cascade,
  event_type text not null,
  event_at text not null,
  duration_ms integer,
  event_json text not null
);

create table tool_events (
  id integer primary key autoincrement,
  task_id text not null references task_runs(id) on delete cascade,
  tool_call_id text,
  tool_kind text not null,
  command_class text,
  command_redacted text,
  cwd_hash text,
  started_at text not null,
  finished_at text,
  exit_code integer,
  output_summary text,
  output_redacted integer not null default 1
);

create table runtime_attempts (
  id integer primary key autoincrement,
  task_id text not null references task_runs(id) on delete cascade,
  runtime text not null,
  profile_version text not null,
  command_class text,
  command_redacted text,
  started_at text not null,
  finished_at text,
  exit_code integer,
  result text not null,
  error_summary text
);

create table review_summaries (
  task_id text primary key references task_runs(id) on delete cascade,
  changed_file_count integer not null,
  additions integer not null default 0,
  deletions integer not null default 0,
  patch_hash text,
  changed_files_json text not null,
  approval_checks_json text not null,
  approved_at text
);
```

Telemetry storage rules:

- Store file paths as relative paths when they are part of the review; hash absolute roots and worktree paths.
- Store command text only after redaction/classification.
- Store output summaries and short errors, not full raw output by default.
- Store diff stats and patch hashes, not full diffs by default.
- Keep prompt bodies out of telemetry tables unless the user explicitly exports a debug bundle that includes them.
- Add pruning by `retention_days`.
- Export as a redacted JSON bundle first; CSV can come later.

Keep JSON storage hardened too:

- Validate schema on read.
- Use atomic writes.
- Add version fields.
- Cap task/chat event snapshots used by the UI.

## Security requirements

- Renderer stays untrusted.
- Main process remains the only filesystem, shell, Git, OpenCode, model-probing, IDE, and storage authority.
- All IPC channels validate sender origin.
- All filesystem paths are normalized and checked against the expected workspace or Aegis-controlled worktree root.
- Web fetch/search stay denied.
- Public model providers stay disabled.
- Public provider fallback is forbidden.
- Model endpoint is explicit and visible.
- Final approval is always manual.
- Worktree cleanup is idempotent.
- Secret path checks and secret scanning run before approval.
- Generated runtime/build files are filtered from review and approval.
- Package manager, system install, `sudo`, and external-directory writes require explicit policy handling.
- Settings must show provider, privacy, runtime, and permission state plainly.
- MVP OpenCode hardening must be verified by tests or startup assertions, not only by developer intention.

## Runtime and package manager choice

Keep the MVP on the current Node/npm/Electron/Vite path unless there is a clear packaging or performance problem. The current app already depends on Electron, Vite, React, and the OpenCode npm package, so switching the runtime/package manager during MVP would create risk without directly improving the core product loop.

Bun is worth evaluating after the MVP for:

- Faster installs and script startup.
- Simpler TypeScript tooling in some local scripts.
- Potentially cleaner packaging for internal developer builds.
- Running future Aegis-owned tooling outside Electron.

Bun should not be the default MVP migration unless it cleanly supports the Electron build, native dependencies, OpenCode package resolution, Windows/macOS/Linux packaging, and CI. A reasonable post-MVP task is a Bun compatibility spike, not a rewrite.

## Build order

1. Document the current app architecture in the plan and README so the team aligns on Electron desktop as the MVP shell.
2. Add a real Settings page and route/surface from the existing placeholder.
3. Move current OpenCode harness logic behind an `AegisRunner`/`OpenCodeRunner` abstraction.
4. Add policy versioning and runner metadata to every task.
5. Add local SQLite telemetry schema, retention, Settings visibility, and redacted export.
6. Harden JSON storage with schema versions and atomic writes.
7. Expand model settings for LM Studio base URL, probe status, model selection, and diagnostics.
8. Add optional local profile and SSO-ready account settings.
9. Promote the Python prompt policy into a runtime profile with explicit checks and telemetry.
10. Add Markdown task classification and docs review summaries.
11. Add C/C++ and CMake runtime detection, generated path filtering, and build/test command profiles.
12. Add PowerShell command profile and Windows-specific safety checks.
13. Add Linux/macOS shell command profile and deny/ask rules for risky commands.
14. Improve command classification for permissions and event display.
15. Add `aegis.yaml` repo policy support if a simple version can be done without slowing the MVP.
16. Add editor preference settings and expand editor detection.
17. Polish review and approval flows around patch hash, metadata, undo, and keep-workspace actions.
18. Add smoke fixtures for Python, Markdown, CMake, and shell tasks.
19. Package a local MVP build that runs without public provider credentials.

## MVP acceptance criteria

The MVP is ready when:

- A developer can run `npm install` and `npm run desktop:dev`, open the Electron app, and complete real local tasks.
- A local LM Studio model is discovered and selectable in Settings.
- Public providers and web tools remain disabled.
- A Git code-change task creates an Aegis-controlled worktree, runs locally, shows tool events, produces a review diff, and merges only after approval.
- A folder task can run with snapshot review and undo.
- Python tasks use the Aegis Python runtime profile and do not verify with bare Python commands.
- Markdown tasks can be edited and reviewed without unnecessary shell execution.
- C/C++ CMake tasks can configure/build/test in an Aegis-generated build directory when tools exist.
- PowerShell and Linux/macOS shell commands are classified, logged, and bounded by policy.
- Settings exposes account, models, permissions, runtimes, privacy/telemetry, editors, and diagnostics.
- Optional SSO can be configured without making local MVP use impossible.
- Local telemetry can be inspected/exported without uploading data.
- Telemetry policy can represent developer-toggle, managed-required, and managed-disabled modes.
- OpenCode package hardening is covered by startup assertions or tests.
- The product reads as Aegis: a local safe-delegation system with its own policies, review, and telemetry, using OpenCode as a foundation rather than as the whole product.

## MVP demo script

1. Start LM Studio and load a local coding-capable model.
2. Run:

```powershell
npm install
npm run desktop:dev
```

3. Open Settings.
4. Confirm LM Studio is reachable and select the model.
5. Confirm telemetry is local-only.
6. Select a Git repository.
7. Ask Aegis to make a small Python change and run verification.
8. Approve worktree creation.
9. Watch reasoning, tool actions, permission prompts, and runtime events.
10. Review the diff.
11. Open the changed file in the selected editor.
12. Accept + merge.
13. Export the local task telemetry.
14. Repeat with a Markdown docs change.
15. Repeat with a small CMake project if the toolchain is installed.

## Post-MVP implementation plan

Defer these until the local MVP is working:

- Company-hosted OpenAI-compatible model endpoint.
- Required enterprise SSO.
- Central policy service.
- Telemetry sync with admin controls.
- Server-side model routing and billing/accounting.
- Remote workers for large repos or long-running builds.
- Admin dashboard.
- IDE extensions.
- Full OpenCode fork or replacement behind the Aegis Runner contract.
- Bun compatibility spike for package management/build tooling.
- Shared team prompt/runtime policies.
- Organization-wide audit and compliance export.

## Codebase references

- `Future_OpenCode_Fork_Plan.md`
- `README.md`
- `desktop/README.md`
- `desktop/src/main/main.ts`
- `desktop/src/main/opencodeHarness.ts`
- `desktop/src/main/config.ts`
- `desktop/src/main/storage.ts`
- `desktop/src/main/types.ts`
- `desktop/src/preload/preload.ts`
- `desktop/src/renderer/main.tsx`
- `desktop/src/renderer/styles.css`
