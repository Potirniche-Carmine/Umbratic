# Aegis Project Status

Aegis is a local-first Electron desktop app for running coding-agent tasks in a
controlled workspace. The intended product flow is:

1. Pick a repository or folder.
2. Ask for a code change in chat.
3. Aegis creates an isolated task workspace.
4. OpenCode runs the agent harness and tool calls.
5. Ollama serves the local LLM through an OpenAI-compatible endpoint.
6. The user reviews the result and explicitly approves the merge or keeps the
   worktree.

The detailed build brief lives in [First_Implementation_Test.md](First_Implementation_Test.md).

## Security Model

The security goal is to keep the renderer UI untrusted and make the Electron
main process the only place that can touch the filesystem, shell, Git, OpenCode,
or IDE handoff.

Current protections:

- Electron runs with `contextIsolation`, `sandbox`, `nodeIntegration: false`,
  `webSecurity: true`, no `<webview>`, and blocked permission requests.
- Navigation is restricted to the local app origin, and new windows are denied.
- The renderer gets a small named `window.aegis` preload API instead of direct
  `ipcRenderer`, raw shell, raw filesystem, or generic native requests.
- IPC calls are checked against the expected sender origin before main-process
  work runs.
- Git and process operations are centralized in the main process and use
  allowlisted flows.
- Normal mode asks before worktree/tool actions. Bypass mode reduces prompts but
  still does not bypass sandboxing, provider lockdown, path checks, blocked-file
  policy, secret scanning, or final approval.
- Final merge is always manual.

## Where We Are Now

The proof-of-value desktop app is running and the UI direction has been
validated.

Implemented now:

- Secure Electron/Vite/React shell.
- Repository or folder selection.
- Chat-style task UI with archived chats, file mentions, command stream, review
  panel, permission mode, IDE open button, and approval checks.
- Ollama health check against `http://127.0.0.1:11434/v1/models`.
- Default local model label/config for `local-ollama/gemma4:e4b`.
- OpenCode binary detection and an Ollama-only OpenCode config builder.
- Git worktree flow for Git repositories, plus in-place folder proof flow.
- Scripted Python hello-world test flow that writes `hello_world.py`, runs it,
  shows command output, produces a review diff, and allows approve/reject.
- Approval safety checks, including clean branch/base checks, blocked paths,
  secret scan, patch hash, commit, fast-forward merge, metadata, and cleanup.

Important current limitation:

The chat is not yet powered by OpenCode or a local LLM. The prompt currently
drives a prebaked Python validation flow. That was useful to prove the secure
UI, worktree lifecycle, review, approval, and merge path, but it is not the real
agent product yet.

## What Is Left

To turn this into the working product, the next phase is replacing the scripted
hello-world runner with the real OpenCode/Ollama loop.

Remaining work:

1. Start OpenCode headlessly from the main process for each task workspace.
2. Launch OpenCode with the generated local-only config:
   `local-ollama/gemma4:e4b`, provider traffic only to
   `http://127.0.0.1:11434/v1`, sharing disabled, public providers disabled,
   web fetch/search denied.
3. Connect to OpenCode's HTTP/SSE event stream and translate raw OpenCode events
   into the existing Aegis UI event types.
4. Send the user's actual prompt and attached file context into an OpenCode
   session instead of always running the Python proof script.
5. Route OpenCode permission requests through Aegis normal/bypass mode.
6. Stream real assistant tokens and tool calls into the current chat timeline.
7. Let OpenCode perform file edits and verification commands inside the
   worktree, while Aegis keeps ownership of task state, path checks, review,
   approval, merge, metadata, and cleanup.
8. Replace the hello-world-only approval verification with task/repo-aware test
   results while keeping blocked-file and secret-scan gates.
9. Add product polish around model availability, Ollama model pull guidance,
   OpenCode startup failures, and richer IDE detection.

## Run

```powershell
npm install
npm run desktop:dev
```

Use the Electron app for real task flows. The Vite browser preview can show the
UI, but it cannot use the preload bridge, pick folders, run commands, or talk to
the local agent backend.
