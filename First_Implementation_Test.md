---
tags: [ai-project, poc, proof-of-value, cli, local, worktree, ollama]
status: draft
research_date: 2026-05-02
---

# First Implementation Test

This is the simplest local test of the idea. The developer's Windows machine
owns the clone, worktree, commands, review, merge, and cleanup. Model calls go
only to local Ollama at `http://127.0.0.1:11434/v1`.

The best first implementation is an **Aegis** app shell built on the local
WarpUI crates, wrapped around stock OpenCode plus a local worktree harness.
WarpUI owns the visual surface. OpenCode owns the agent loop and tool use. Aegis
owns repo safety, provider config, task records, review, merge, and cleanup. The
first test should not fork the full Warp desktop app.

Backlinks: [[Index]], [[MVP_Implementation_Plan]], [[Enterprise_Backend_and_Local_POC]], [[Security_Privacy_Requirements]]

## Point of the test

Validate this:

> One command, `aegis`, opens an interactive local coding session that can chat,
> create a local Git worktree, generate an isolated OpenCode config for local
> Ollama, ask OpenCode for a small change, show the diff, open the editor, and
> merge or reject the result.

This test should be boring under the hood. No server-side Git. No remote
worker. No dashboards. No public model provider credentials. No full Warp fork.
The UI can be polished because it is built on the local WarpUI crates, not the
broader Warp app.

## What to prove

- The OpenCode runner can make useful changes in a local worktree.
- The developer can review the changes without losing control.
- The WarpUI shell makes task status, traces, diffs, and review actions easy to
  see.
- The workflow is easier than manually juggling branches and agent sessions.
- The CLI can clean up safely.
- The model path is one localhost Ollama provider with no public fallback.
- The same flow can later point at an internal OpenAI-compatible endpoint by
  changing one base URL and provider name.
- The fallback direct Ollama harness can sanity-check local model behavior if
  OpenCode blocks on tool calling or no-key local endpoints.

## Setup assumptions

The developer has:

- Git installed.
- Rust/Cargo installed.
- OpenCode installed.
- Ollama installed and running locally.
- The model `gemma4:e4b` available in Ollama.
- An editor command available, such as `code`, `cursor`, `windsurf`, `idea`,
  `pycharm`, `webstorm`, `rider`, or `clion`.

No API keys are needed for this first implementation test. Do not configure
public providers.

## Start Local Ollama

Run Ollama locally if it is not already running as a background app/service:

```powershell
ollama serve
```

In another terminal, pull the model:

```powershell
ollama pull gemma4:e4b
```

Verify the OpenAI-compatible endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/v1/models | ConvertTo-Json -Depth 5
```

## Config

User config:

```toml
# ~/.aegis/config.toml
provider = "local-ollama"
ai_endpoint = "http://127.0.0.1:11434/v1"
model = "gemma4:e4b"
model_id = "gemma4:e4b"
default_editor = "code"
worktree_root = "../.aegis-worktrees"
runner = "opencode"
fallback_runner = "direct-ollama"
```

Repo config:

```toml
# .aegis.toml
test_command = "python hello_world.py"
allowed_commands = ["python hello_world.py", "python3 hello_world.py", "npm test", "npm run lint", "cargo test"]
```

Do not put secrets in either file. The first test should not need secrets at all.

## Command Shape

```powershell
aegis
aegis "explain this repo"
```

Inside the app:

```text
/help
/pull
/doctor
/task <prompt>
/task! <prompt>
/runner opencode
/opencode [prompt]
/status
/diff <task-id>
/open <task-id>
/merge <task-id>
/reject <task-id>
/clear
/exit
```

Keep script-friendly compatibility commands hidden from normal help output, but
the primary UX should be a single `aegis` command that opens the WarpUI shell.

## First visual experience

The first implementation should use the local WarpUI fork as the visual
foundation, the same way it uses OpenCode as the agent/harness foundation.

Use the repo-local crates:

- [[warpui_core]]
- [[warpui]]

The first Aegis UI should be a small desktop shell, not a fork of the full Warp
app. It should render Aegis task state from the local harness:

- task header with repo, branch, model, and worktree,
- live OpenCode runner status,
- command/action trace grouped by step,
- changed-file summary,
- diff stat and test status,
- review actions: open, diff, revise, merge, reject, keep,
- local configuration and `/doctor` status.

The product split is:

```text
WarpUI crates -> Aegis app shell and review surface
OpenCode      -> agent loop and tools
Ollama        -> first local OpenAI-compatible endpoint
Aegis         -> worktrees, policy, task state, review, merge, cleanup
```

Do not port Warp's product backend, cloud sync, auth, model marketplace,
telemetry, or agent orchestration. Keep WarpUI as a UI framework and component
base only.

## Step-by-step implementation

### 1. `aegis`

Bare `aegis` opens the interactive app. `aegis "prompt"` opens the app and sends
the initial prompt first. The app keeps chat context until `/clear` or `/exit`.

### 2. `/doctor`

Check:

```powershell
git --version
opencode --version
git rev-parse --show-toplevel
git status --porcelain
ollama --version
Invoke-RestMethod http://127.0.0.1:11434/v1/models
```

Also check:

- configured editor command exists,
- configured OpenCode command exists,
- `ai_endpoint` is `http://127.0.0.1:11434/v1` for the first test,
- configured provider is exactly `local-ollama`,
- configured model is listed by Ollama,
- no dirty base worktree,
- no public provider credentials are required.

Print the planned network destination:

```text
AI endpoint: http://127.0.0.1:11434/v1
Ollama model: gemma4:e4b
Model alias: gemma4:e4b
API key: not used
Enabled providers: local-ollama only
```

### 3. Detect repo state

Inside a repo:

```powershell
git rev-parse --show-toplevel
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --porcelain
```

Stop if dirty. The first real test should not mix human edits and agent edits.
Use `--allow-dirty-base` only for throwaway smoke tests.

### 4. Create local worktree

Branch:

```text
aegis/task-123-fix-auth-session-test
```

Command:

```powershell
git worktree add -b aegis/task-123-fix-auth-session-test ../.aegis-worktrees/task-123 <base-commit>
```

Store the absolute worktree path.

### 5. Run stock OpenCode through local Ollama

OpenCode is the primary runner for this test because it already brings a TUI,
tool loop, file editing, shell commands, and session handling. Aegis should
generate an isolated OpenCode config with only the local Ollama provider:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "local-ollama/gemma4:e4b",
  "small_model": "local-ollama/gemma4:e4b",
  "enabled_providers": ["local-ollama"],
  "provider": {
    "local-ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local Ollama",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1"
      },
      "models": {
        "gemma4:e4b": {
          "name": "Local gemma4:e4b"
        }
      }
    }
  },
  "mcp": {},
  "plugin": [],
  "instructions": [],
  "share": "disabled",
  "autoupdate": false
}
```

Launch OpenCode inside the task worktree:

```powershell
$env:OPENCODE_CONFIG = "<task-opencode-config>"
$env:OPENCODE_DISABLE_AUTOUPDATE = "true"
$env:OPENCODE_DISABLE_MODELS_FETCH = "true"
$env:OPENCODE_AUTO_SHARE = "false"
$env:OPENCODE_ENABLE_EXA = "false"
$env:OPENCODE_DISABLE_DEFAULT_PLUGINS = "true"
$env:OPENCODE_DISABLE_LSP_DOWNLOAD = "true"
opencode run --model local-ollama/gemma4:e4b "<task prompt>"
```

Use `/opencode [prompt]` to launch OpenCode's TUI in the current repo. Use
`/runner opencode` and then `/task <prompt>` to run the Aegis worktree harness
through OpenCode.

### 6. Keep a direct Ollama fallback harness

Keep the direct runner tiny. It is not the main product path; it is a diagnostic
fallback for checking whether the local model can produce a small patch when
OpenCode integration is the thing failing.

The direct runner asks Ollama for a strict JSON file plan:

```json
{
  "summary": "short text",
  "files": [
    {
      "path": "relative/path",
      "content": "complete file contents"
    }
  ],
  "test_command": null
}
```

The wrapper rejects absolute paths, parent-directory escapes, and writes under
`.git`. Test commands only run if `.aegis.toml` allows them.

### 7. Capture output

After the runner exits:

```powershell
git -C <worktree> status --short
git -C <worktree> diff --stat <base-commit>
git -C <worktree> diff <base-commit>
```

Store:

- runner exit code,
- changed files,
- diff stat,
- stdout/stderr or model response log path,
- test command result if configured.

Do not store full code in telemetry by default.

### 8. Review

Editor detection order:

1. Repo config.
2. User config.
3. `code`.
4. `cursor`.
5. `windsurf`.
6. `idea`, `pycharm`, `webstorm`, `rider`, `clion`.
7. Terminal diff.

Open editor:

```powershell
code --wait <worktree-path>
```

Terminal fallback:

```text
[d] show diff
[o] open editor
[r] revise
[m] merge
[x] reject
[k] keep worktree open
```

### 9. Revise

Run the selected runner again in the same worktree:

```text
Original task:
<task prompt>

Developer feedback:
<feedback>

The current diff is already in the working tree. Revise it without broadening scope.
```

Record `revision_requested`.

### 10. Merge

Before merge:

- show final diff stat,
- confirm base branch,
- warn if base commit moved,
- stop if current base worktree is dirty.

Merge locally:

```powershell
git switch <base-branch>
git merge --no-ff aegis/task-123-fix-auth-session-test
```

If conflicts happen, stop and leave the worktree intact.

### 11. Cleanup

After successful merge:

```powershell
git worktree remove <worktree-path>
git branch -d aegis/task-123-fix-auth-session-test
git worktree prune
```

`cleanup` should be safe to run more than once.

## Testing checklist

For each test repo, record:

- Did Ollama respond at `http://127.0.0.1:11434/v1/models`?
- Did the CLI use only `local-ollama` and `gemma4:e4b`?
- Did it avoid all public providers?
- Did it write only inside the worktree?
- Did it run only allowed commands?
- Did the diff stay small enough to review?
- Did the editor handoff feel natural?
- Did merge and cleanup work?
- Did any unexpected network request happen?

## What not to build

- No server-side Git.
- No remote worker.
- No real PR creation.
- No telemetry sync.
- No full Warp terminal app.
- No full Warp app fork.
- No API key setup.

## How this becomes the MVP

The MVP is this same loop, cleaned up:

- better CLI naming,
- an Aegis-branded command vocabulary and copy,
- safer config,
- WarpUI-based Aegis shell as the primary UI,
- stock OpenCode first, then a stripped OpenCode fork only after the loop proves
  useful,
- one internal OpenAI-compatible endpoint,
- stronger worktree boundary checks,
- better terminal review,
- local telemetry export,
- optional Git provider PR creation from the developer machine.

The server question can wait. First prove the local loop.

## Sources

- [[MVP_Implementation_Plan]]
- [[Warp]]
- [OpenCode provider docs](https://opencode.ai/docs/providers/)
- [Ollama Gemma 4 model](https://ollama.com/library/gemma4)
- [Git worktree docs](https://git-scm.com/docs/git-worktree.html)
