# Aegis Project Status

Aegis is a local-first Electron desktop app for running coding-agent tasks in a
controlled workspace. The intended product flow is:

1. Pick a repository or folder.
2. Ask for a code change in chat.
3. Aegis creates an isolated task workspace.
4. OpenCode runs the agent harness and tool calls.
5. Ollama or LM Studio serves the local LLM through an OpenAI-compatible
   endpoint.
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
- Local model discovery for Ollama and LM Studio OpenAI-compatible endpoints.
- Model picker backed by the currently reachable local providers and models.
- OpenCode binary detection and local-only OpenCode config generation for the
  selected provider/model.
- Per-task password-protected OpenCode headless server startup on loopback.
- OpenCode HTTP/SSE integration that sends the real prompt, streams assistant
  text/tool events, and routes tool permissions through Aegis.
- Chat-only turns can complete without file changes; Aegis only asks for a Git
  worktree up front when the prompt clearly requests file/code changes, or later
  when OpenCode requests an edit tool from a read-only chat turn.
- Follow-up prompts in a chat append to the same Aegis/OpenCode session history
  instead of replacing the conversation with a new task.
- Git worktree flow for Git repositories, plus in-place folder proof flow.
- Review diff and approve/reject flow for real OpenCode-authored changes.
- Approval safety checks, including clean branch/base checks, blocked paths,
  secret scan, patch hash, commit, fast-forward merge, metadata, and cleanup.

## What Is Left

Remaining work:

1. Add task/repo-aware test command discovery and surfaced verification results.
2. Add product polish around model availability, Ollama model pull guidance,
   OpenCode startup failures, and richer IDE detection.
3. Broaden automated coverage around OpenCode event translation, permission
   routing, and approval edge cases.

## Run

```powershell
npm install
npm run desktop:dev
```

Use the Electron app for real task flows. The Vite browser preview can show the
UI, but it cannot use the preload bridge, pick folders, run commands, or talk to
the local agent backend.
