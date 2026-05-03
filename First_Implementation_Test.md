---
tags: [ai-project, poc, proof-of-value, desktop, electron, local, opencode, ollama, worktree, security]
status: draft
research_date: 2026-05-03
---

# First Implementation Test

This document is the build brief for the first useful Aegis desktop test. The
desktop app should be intentionally small, but the workflow itself should be
real: a user asks for a repository change, Aegis creates an isolated Git
worktree, OpenCode does the agent work, the user reviews the result in their IDE,
and Aegis safely approves or rejects the merge.

OpenCode is the full agent backend. Ollama is the local model backend. Electron
is only the secure desktop shell and workflow coordinator.

Backlinks: [[Index]], [[MVP_Implementation_Plan]], [[Enterprise_Backend_and_Local_POC]], [[Security_Privacy_Requirements]]

## Product Decision

- The app is a tiny Electron desktop shell over OpenCode.
- The UI starts all user actions. The user should not type Aegis CLI commands.
- OpenCode owns the agent loop, file edits, shell tools, permission requests,
  sessions, and model calls.
- Aegis owns repository selection, worktree creation, merge approval policy, IDE
  handoff, task metadata, and safety checks.
- Ollama replaces LM Studio. The default local endpoint is
  `http://127.0.0.1:11434/v1`.
- The default local model is `gemma4:e4b`, with the model ID configurable.
- Normal and bypass permission modes stay.
- Worktrees are in scope for this first test.
- Git diff as an in-app review surface is not in scope. The user reviews in
  their preferred IDE.
- Terminal UI is not in scope. Backend commands should be shown as a read-only
  command/tool stream.
- Frontend telemetry/debug dumps are not in scope. Task metadata and approval
  telemetry are backend/app records, not a raw renderer telemetry panel.
- Final merge is never automatic. Even in bypass mode, the user must click
  Approve before Aegis merges into the original branch.

## Point of the Test

Validate this:

> A developer opens Aegis, selects a repository, asks "write me a hello world
> Python script", lets Aegis create a worktree, watches OpenCode create and test
> the file, opens the worktree in VS Code or Visual Studio for review, then
> clicks Approve so Aegis runs merge checks, merges the agent branch back into
> the original branch, records the task metadata, and removes the worktree.

The Python hello-world task is not a special app feature. It is the first
representative use case for the full loop: prompt, worktree, tool calls,
verification, IDE review, approval checks, merge, cleanup.

## User Flow

1. User selects a repository folder.
2. User asks for a change in the chat input.
3. Aegis detects the original branch and base commit.
4. In normal mode, Aegis asks: "Create an isolated worktree for this task?"
5. In bypass mode, Aegis creates the worktree automatically.
6. Aegis starts or points OpenCode at the worktree.
7. OpenCode uses tools until it believes the task is complete.
8. The UI streams assistant tokens and command/tool events live.
9. Normal mode shows OpenCode permission prompts for writes, installs, shell
   commands, and sensitive actions. Bypass mode auto-allows those OpenCode
   prompts according to policy.
10. OpenCode verifies the change, such as running `python hello_world.py`.
11. If Python is missing, OpenCode may create a uv-managed environment and
    install Python inside the worktree runtime area, with commands visible.
12. Aegis asks where to open the completed worktree: VS Code, Visual Studio,
    Cursor, Windsurf, JetBrains, or file explorer fallback.
13. User reviews the changes in the IDE.
14. Aegis asks whether to Approve and merge into the original branch.
15. User clicks Approve.
16. Aegis runs the approval checks.
17. If checks pass, Aegis commits the allowed worktree changes to the agent
    branch, merges that branch into the original branch, records final metadata,
    deletes the worktree, and keeps the task record.
18. If checks fail, Aegis stops, keeps the worktree, and shows the reason.

## What to Prove

- Electron is hardened before adding features.
- The renderer cannot access Node, shell, filesystem, `ipcRenderer`, raw Git
  commands, or raw OpenCode credentials.
- The preload API is small, typed, and allowlisted.
- The user can select a real repository.
- Aegis can create a local Git worktree safely.
- OpenCode can run in that worktree with only local Ollama enabled.
- The UI streams assistant tokens as they arrive.
- The UI shows backend command/tool events, including command text, cwd, status,
  permission state, output excerpt, and exit result where available.
- Normal mode asks before worktree creation and OpenCode write/shell actions.
- Bypass mode automatically creates the worktree and auto-allows OpenCode tool
  prompts, but does not auto-merge.
- The hello-world use case creates a file, verifies it, handles missing Python
  by using uv if needed, and returns to the user for IDE review.
- The Approve path performs the required checks before merging.
- Aegis deletes the worktree only after a successful merge.
- Failed checks preserve the worktree and task metadata for inspection.

## Existing Repo Notes

The current repo already has an Electron/Vite workspace under `desktop`.
Important observations for the developer:

- `desktop/package.json` already depends on `electron`, React, `opencode-ai`,
  and `@opencode-ai/sdk`.
- `desktop/src/main/main.ts` currently supervises OpenCode, but it is still
  configured around LM Studio at `http://127.0.0.1:1234/v1`.
- `desktop/src/main/main.ts` already has some Git and worktree helpers, but they
  need to become part of an explicit task lifecycle and approval policy.
- `desktop/src/main/main.ts` still exposes a terminal bridge. Remove that
  terminal UI/IPC surface for this phase.
- `desktop/src/preload/preload.ts` currently exposes broad helpers including
  `nativeRequest(payload: unknown)`. Replace this with named, typed methods.
- `desktop/src/renderer/main.tsx` still contains raw telemetry/debug UI,
  terminal UI, and in-app diff UI concepts. Remove or hide them for this phase.
- The BrowserWindow already sets `contextIsolation: true` and
  `nodeIntegration: false`, but the security pass must explicitly add and verify
  renderer sandboxing, CSP, navigation limits, window-open limits, and IPC sender
  validation.

Treat generated files under `desktop/dist-electron` as build output. The plan
below is for source changes.

## Target Architecture

```text
Electron renderer
  Small React UI:
  repository picker, backend status, permission mode, chat stream,
  command/tool stream, worktree prompt, IDE handoff prompt, approve/reject.

Preload bridge
  Minimal typed API:
  no direct ipcRenderer, no arbitrary payload channel, no shell/filesystem
  primitives, no generic nativeRequest.

Electron main process
  OpenCode supervisor and workflow broker:
  validates repo paths, creates worktrees, starts OpenCode in worktrees,
  maps OpenCode events to UI events, runs merge approval checks,
  performs allowlisted Git operations, records metadata.

OpenCode backend
  Full agent backend:
  sessions, messages, file edits, shell/tool execution, permission requests,
  event stream, command/tool metadata.

Ollama
  Local OpenAI-compatible model endpoint:
  http://127.0.0.1:11434/v1, default model gemma4:e4b.
```

## Electron Security Requirements

Electron is risky here because the app bundles Chromium and Node, and the agent
backend can run real commands. A renderer bug becomes dangerous if IPC can reach
privileged operations.

Required BrowserWindow and app settings:

```ts
app.enableSandbox();

const win = new BrowserWindow({
  webPreferences: {
    preload: path.resolve(__dirname, "../preload/preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
  },
});
```

Required app behavior:

- Load only the packaged local app in production.
- During development, load only `http://127.0.0.1:5173`.
- Do not load remote web content.
- Do not set `webSecurity: false`.
- Do not enable Node integration anywhere.
- Do not disable context isolation.
- Do not disable the Chromium/Electron sandbox for production.
- Do not use `<webview>` for this test.
- Deny arbitrary permission requests with `session.setPermissionRequestHandler`.
- Block navigation away from the app origin.
- Deny new windows with `setWindowOpenHandler`.
- Do not call `shell.openExternal` on renderer-provided URLs.
- Prefer a custom app protocol for production assets instead of raw `file://`.
- Keep Electron current during productization because Electron ships Chromium
  and Node with the app.

Required CSP:

```html
<meta
  http-equiv="Content-Security-Policy"
  content="
    default-src 'self';
    script-src 'self';
    style-src 'self';
    img-src 'self' data:;
    font-src 'self';
    connect-src 'self' http://127.0.0.1:*;
    object-src 'none';
    base-uri 'none';
    frame-ancestors 'none';
    form-action 'none';
  "
/>
```

Use the narrowest possible `connect-src`. Prefer proxying OpenCode through the
main process so the renderer does not receive OpenCode Basic auth credentials.

## IPC Rules

Delete the generic `nativeRequest(payload: unknown)` pattern.

Expose only named methods from preload:

```ts
window.aegis = {
  pickRepository(): Promise<PickRepositoryResult>;
  getBackendStatus(): Promise<BackendStatus>;
  setPermissionMode(mode: "normal" | "bypass"): Promise<BackendStatus>;
  startTask(input: { repositoryId: string; prompt: string }): Promise<TaskInfo>;
  approveWorktreeCreation(input: { taskId: string; approved: boolean }): Promise<void>;
  respondToToolPermission(input: ToolPermissionDecision): Promise<void>;
  openTaskInIde(input: { taskId: string; ideId: string }): Promise<IdeOpenResult>;
  approveTaskMerge(input: { taskId: string }): Promise<ApproveResult>;
  rejectTask(input: { taskId: string; cleanup: boolean }): Promise<void>;
  keepWorktree(input: { taskId: string }): Promise<void>;
  cancelTask(input: { taskId: string }): Promise<void>;
  onBackendEvent(callback: (event: BackendUiEvent) => void): () => void;
};
```

Implementation requirements:

- Validate every IPC sender origin using `event.senderFrame`.
- Validate every payload shape in the main process with runtime schemas.
- Resolve repository and worktree paths in the main process.
- Reject paths outside selected repositories and controlled worktree roots.
- Never expose `ipcRenderer` itself.
- Never expose arbitrary `spawn`, `exec`, shell, filesystem, or URL-opening
  methods.
- Never expose raw OpenCode credentials to renderer code.
- Run Git operations through allowlisted main-process functions that use
  `execFile` with argument arrays, not shell strings.
- Route agent commands through OpenCode and the permission engine.
- Bypass mode may reduce prompts, but it must not bypass IPC validation,
  provider lockdown, Electron sandboxing, worktree boundaries, blocked-file
  policy, secret scanning, or final merge approval.

## Worktree Lifecycle

Create worktrees outside the original repository so the original branch does not
become dirty just because a task starts.

Suggested paths:

```text
<repo-parent>/.aegis-worktrees/<repo-name>/<task-id>/
```

Suggested branch naming:

```text
aegis/<task-id>-<slug>
```

Before creating a worktree:

- Verify selected path is a Git repository.
- Capture original repository root.
- Capture original branch name.
- Capture original base commit.
- Capture original status.
- If original branch is dirty, ask the user to clean it or explicitly choose a
  separate "dirty base" smoke-test path that cannot be approved for merge.

Normal mode:

- Show a worktree creation prompt with branch, base commit, and target path.
- Only create the worktree if the user approves.

Bypass mode:

- Create the worktree automatically after the user sends the prompt.
- Still show a task event saying which worktree and branch were created.

Command:

```powershell
git worktree add -b <agent-branch> <worktree-path> <base-commit>
```

After the worktree exists:

- Start OpenCode with `cwd=<worktree-path>`.
- Configure runtime/tool directories so dependency installs happen in the
  worktree or app-controlled task storage, not the user's global environment.
- Track changed files relative to the worktree.
- Do not merge or delete anything until the user clicks Approve.

## OpenCode and Ollama Configuration

Start OpenCode as a headless server on `127.0.0.1` with a random free port and a
per-launch password. OpenCode's server exposes HTTP APIs and SSE events; use
those as the backend contract and verify exact event shapes against the installed
OpenCode version.

Use a generated config like this:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "share": "disabled",
  "autoupdate": false,
  "model": "local-ollama/gemma4:e4b",
  "small_model": "local-ollama/gemma4:e4b",
  "enabled_providers": ["local-ollama"],
  "disabled_providers": [
    "opencode",
    "openai",
    "anthropic",
    "google",
    "gemini",
    "openrouter",
    "xai",
    "azure",
    "amazon-bedrock",
    "groq",
    "mistral",
    "cohere",
    "together",
    "perplexity"
  ],
  "provider": {
    "local-ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local Ollama",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1"
      },
      "models": {
        "gemma4:e4b": {
          "name": "Gemma 4 E4B via Ollama"
        }
      }
    }
  },
  "server": {
    "hostname": "127.0.0.1",
    "mdns": false,
    "cors": []
  },
  "mcp": {},
  "plugin": [],
  "instructions": [],
  "permission": {
    "webfetch": "deny",
    "websearch": "deny",
    "external_directory": "ask",
    "edit": "ask",
    "bash": "ask"
  }
}
```

For bypass mode, restart or patch OpenCode config so `edit` and `bash` are
`allow`. Keep web fetch/search denied and keep external directory access denied
or asked for this first test.

Environment hardening:

- Set `OPENCODE_SERVER_USERNAME=opencode`.
- Set a random per-launch `OPENCODE_SERVER_PASSWORD`.
- Use `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT` for the generated locked
  config.
- Remove public provider API key environment variables from the OpenCode child
  process.
- Remove exporter/observability environment variables unless explicitly needed.
- Point model traffic only at `http://127.0.0.1:11434/v1`.
- Check `http://127.0.0.1:11434/v1/models` before starting a task.
- If `gemma4:e4b` is missing, show a UI action to pull it. Do not silently
  download models.

## Streaming Contract

Use OpenCode events as the source of truth. The UI must render:

- Assistant text deltas as they arrive.
- Tool/command started.
- Tool/command waiting for permission.
- Permission accepted/declined.
- Tool/command stdout/stderr excerpt.
- Tool/command finished with exit status.
- Worktree created.
- Task ready for review.
- Approval checks started, passed, failed, or skipped with reason.
- Merge completed or failed.
- Worktree deleted or retained.

The renderer should consume stable Aegis UI events, not raw OpenCode internals.

```ts
type BackendUiEvent =
  | { type: "assistant.delta"; taskId: string; text: string }
  | { type: "assistant.done"; taskId: string }
  | { type: "worktree.requested"; taskId: string; branch: string; path: string; baseCommit: string }
  | { type: "worktree.created"; taskId: string; branch: string; path: string }
  | { type: "command.started"; taskId: string; id: string; command: string; cwd: string }
  | { type: "command.output"; taskId: string; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "command.finished"; taskId: string; id: string; exitCode: number | null }
  | { type: "permission.requested"; taskId: string; request: PermissionRequest }
  | { type: "permission.resolved"; taskId: string; id: string; decision: "allow" | "deny" }
  | { type: "review.ready"; taskId: string; changedFiles: string[]; latestTest?: TestResult }
  | { type: "approval.check"; taskId: string; name: string; status: "running" | "passed" | "failed"; detail?: string }
  | { type: "merge.completed"; taskId: string; targetBranch: string; commit: string; patchHash: string }
  | { type: "task.error"; taskId: string; message: string };
```

## Hello World Use Case

The developer should implement the general workflow so this prompt works from
the frontend:

```text
Write me a Python hello world script and verify it runs.
```

Expected behavior:

- Aegis creates or asks to create a worktree.
- OpenCode creates `hello_world.py` in the worktree.
- OpenCode runs the script.
- If Python is installed, it uses the available Python.
- If Python is missing, OpenCode creates a uv-managed environment and installs
  Python in the task/worktree runtime area.
- OpenCode reruns the script.
- The UI shows the commands and output.
- The final assistant response says the change is ready for review.
- Aegis asks which IDE to open.
- After review, Aegis asks whether to Approve and merge.

Expected final file:

```python
print("hello world")
```

Expected command output:

```text
hello world
```

Suggested project-local runtime environment for uv commands:

```text
UV_INSTALL_DIR=<worktree>/.aegis/runtime/uv
UV_UNMANAGED_INSTALL=<worktree>/.aegis/runtime/uv
UV_NO_MODIFY_PATH=1
UV_PYTHON_INSTALL_DIR=<worktree>/.aegis/runtime/python
UV_PYTHON_BIN_DIR=<worktree>/.aegis/runtime/python-bin
UV_CACHE_DIR=<worktree>/.aegis/runtime/uv-cache
```

The approval path must exclude `.aegis/runtime/**` and any generated virtual
environment or binary cache from the final patch.

## IDE Review Handoff

Aegis does not need to render diffs in-app for this test. It should open the
worktree in the user's preferred IDE and let the IDE's native Git UI show the
changes.

VS Code support:

- Detect `code` or `code-insiders`.
- Open the worktree with:

```powershell
code --new-window <worktree-path>
```

- VS Code has built-in Git/source-control and worktree support, so the worktree
  should appear as its own repository with changed files available in Source
  Control.
- For individual file comparison, VS Code supports:

```powershell
code --diff <base-file-copy> <worktree-file>
```

- Do not depend on an undocumented VS Code branch-compare CLI command. If a
  "PR-like" review is needed, generate a local patch summary in task metadata
  and open the worktree Source Control view as the primary experience.

Visual Studio support:

- Detect `devenv.exe` where possible.
- Prefer opening the solution file inside the worktree if one exists.
- Otherwise open the worktree folder or fall back to Explorer.
- The app should still show the changed-file list and final approval prompt in
  Aegis, even if the IDE handoff is best-effort.

Other IDEs:

- Detect Cursor, Windsurf, JetBrains IDEs, and file explorer as fallbacks.
- Store the user's preferred IDE choice per repository.

## Approval and Merge Checks

Final merge requires an explicit user click. Bypass mode does not bypass this.

When the user clicks Approve:

```text
Developer clicks Approve
  -> Check original branch exists
  -> Check original branch is clean
  -> Check agent branch exists
  -> Check original branch is still at expected base commit
  -> Check agent branch HEAD is still at expected base commit before Aegis commits
  -> Check worktree path is controlled by Aegis
  -> Check worktree still points at the agent branch
  -> Run required tests or verify latest passing test result
  -> Check secret scan
  -> Check blocked-file policy
  -> Build final patch from allowed files only
  -> Record final diff metadata and patch hash
  -> Create local task commit on the agent branch
  -> Merge branch into original branch
  -> Send or record approval telemetry
  -> Delete worktree
  -> Delete merged agent branch if safe
  -> Keep task metadata and patch hash
```

Detailed requirements:

- Original branch exists: `git show-ref --verify refs/heads/<original-branch>`.
- Original branch is clean: `git status --porcelain` from the original repo must
  be empty before merge.
- Original branch base: `git rev-parse <original-branch>` must equal the
  captured base commit before approval merge. If the original branch moved, stop
  and ask the user whether to rebase/rerun.
- Agent branch base: before Aegis creates the approval commit, `git rev-parse
  <agent-branch>` must still equal the captured base commit. The first
  implementation should not allow OpenCode to create Git commits itself.
- Required tests: use task-specific verification first. For the hello-world use
  case, the latest passing verification must be the script run that printed
  `hello world`. If repo config later defines tests, run those before merge.
- Secret scan: scan the final patch and changed files for obvious secrets before
  staging. If `gitleaks` or another configured scanner exists, use it; otherwise
  run a built-in conservative regex scan.
- Blocked files: never approve changes to `.env`, `.env.*`, private keys,
  credential files, `.git/**`, `.aegis/runtime/**`, dependency caches, virtual
  environments, generated binaries, or paths outside the worktree.
- Final patch: compute from `git diff --binary <base-commit>` after excluding
  blocked files.
- Patch hash: store a stable SHA-256 of the final patch bytes.
- Local task commit: stage only allowed files and commit with an Aegis-generated
  message that includes the task ID and patch hash.
- Merge: switch to the original branch and prefer `git merge --ff-only
  <agent-branch>` when the original branch still equals the captured base. If
  fast-forward is not possible, stop and keep the worktree.
- Telemetry: for this first test, record local task telemetry and patch hash.
  Remote telemetry must be opt-in and must not include secrets or full code by
  default.
- Cleanup: delete the worktree and delete the agent branch only after a
  successful merge and metadata write. Cleanup must be idempotent.

If any check fails, do not merge. Keep the worktree and show the failure with a
next action.

## Frontend Scope

The first screen should be the tool itself, not a landing page.

Required UI:

- Repository picker.
- Current repository label.
- Original branch and base commit summary.
- OpenCode status.
- Ollama status.
- Model label.
- Permission mode segmented control: `Normal` and `Bypass`.
- Chat input.
- Live assistant token stream.
- Read-only command/tool event stream.
- Worktree creation prompt in normal mode.
- Permission approval bar or modal for OpenCode tool requests.
- Review-ready panel with changed files, latest verification, and IDE choices.
- Approve, Reject, and Keep Worktree actions.
- Approval check progress list.

Remove or hide for this phase:

- Raw frontend telemetry panel.
- Debug telemetry JSON.
- In-app Git diff viewer.
- Terminal tab.
- Terminal input/output bridge.
- Integrations dashboard.
- PR creation against a remote provider.
- Any CLI-like command palette that suggests `/task`, `/diff`, `/merge`,
  `/worktree`, `/terminal`, or similar commands.

The command/tool event stream is not a terminal. It is a read-only audit trail of
what OpenCode and Aegis ran.

## Implementation Plan

### 1. Harden Electron First

Update BrowserWindow settings, CSP, navigation blocking, window-open blocking,
permission request handling, and IPC sender validation before expanding the
workflow.

### 2. Replace the Preload Contract

Remove broad helpers and expose only the typed task/worktree/approval methods
listed above.

### 3. Switch From LM Studio to Ollama

Replace `aegis-lmstudio` with `local-ollama`.

Replace `http://127.0.0.1:1234/v1` with `http://127.0.0.1:11434/v1`.

Default to `gemma4:e4b`.

### 4. Implement the Task Lifecycle

Add a task state machine:

```text
draft -> awaiting_worktree_approval -> running -> review_ready
      -> approving -> merged
      -> rejected
      -> failed
```

Bypass mode skips `awaiting_worktree_approval`, but it does not skip
`review_ready` or `approving`.

### 5. Implement Worktree Creation

Use allowlisted Git operations in the main process. Store task metadata with:

- task ID,
- original repo path,
- original branch,
- base commit,
- agent branch,
- worktree path,
- permission mode,
- model/provider,
- created time,
- latest verification result,
- final patch hash after approval.

### 6. Run OpenCode in the Worktree

Start OpenCode with the generated Ollama-only config and `cwd=<worktree-path>`.
Translate OpenCode SSE/events into stable Aegis UI events.

### 7. Implement IDE Handoff

Detect IDEs, prompt the user when the task is review-ready, and open the
worktree. VS Code should use `code --new-window <worktree-path>` as the baseline
because VS Code has built-in Git and worktree support.

### 8. Implement Approval Checks and Merge

Implement the approval checklist exactly. Treat every failure as a stop, not as
a warning to click through. Keep the worktree on failure.

### 9. Verify With the Hello World Use Case

From the frontend, ask for the Python hello-world script. Verify:

- normal mode asks to create the worktree,
- bypass mode creates it automatically,
- commands stream live,
- OpenCode creates the file,
- Python missing path uses uv-managed Python,
- script prints `hello world`,
- IDE opens the worktree,
- Approve runs checks,
- merge succeeds,
- worktree is deleted,
- task metadata and patch hash remain.

## Manual QA Checklist

- Renderer has no Node access.
- `window.require`, `process`, and direct `ipcRenderer` are unavailable in the
  renderer.
- Preload exposes only the small `window.aegis` API.
- CSP is present.
- Navigation away from the app is blocked.
- New windows are blocked.
- Remote content is not loaded.
- Ollama health check uses `http://127.0.0.1:11434/v1/models`.
- OpenCode config enables only `local-ollama`.
- LM Studio text and port `1234` are gone from UI and backend config.
- Worktree prompt appears in normal mode.
- Worktree is automatic in bypass mode.
- Original repo does not become dirty from worktree creation.
- OpenCode runs inside the worktree.
- Live assistant tokens stream.
- Backend command/tool events render live.
- Permission requests render and can be accepted/declined in normal mode.
- Bypass mode still shows commands live.
- Hello-world prompt creates `hello_world.py`.
- Verification prints `hello world`.
- Review-ready panel offers IDE choices.
- VS Code opens the worktree in a new window.
- Approve runs every merge check.
- Blocked runtime files are not staged or merged.
- Secret scan failure blocks merge.
- Merge into the original branch succeeds only after checks pass.
- Worktree is deleted only after successful merge.
- Failed approval keeps the worktree.
- Task metadata and patch hash are retained.
- Raw frontend telemetry panel is gone.
- Terminal UI and IPC are gone.

## What Not to Build Yet

- No Aegis CLI product flow.
- No in-app diff viewer.
- No terminal panel.
- No frontend telemetry/debug dump.
- No integrations dashboard.
- No remote PR creation.
- No public provider setup.
- No remote content.
- No arbitrary shell or filesystem IPC.
- No custom agent framework outside OpenCode.

## Sources Checked

- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [OpenCode Server](https://opencode.ai/docs/server/)
- [OpenCode Config](https://opencode.ai/docs/config/)
- [OpenCode Permissions](https://opencode.ai/docs/permissions)
- [OpenCode Providers](https://opencode.ai/docs/providers)
- [Ollama OpenAI Compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama Gemma 4](https://ollama.com/library/gemma4)
- [uv Installer Options](https://docs.astral.sh/uv/reference/installer/)
- [uv Storage](https://docs.astral.sh/uv/reference/storage/)
- [VS Code CLI](https://code.visualstudio.com/docs/editor/command-line)
- [VS Code Source Control](https://code.visualstudio.com/docs/editor/versioncontrol)
- [VS Code Branches and Worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees)
