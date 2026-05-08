# Aegis Desktop PoV

This is the first runnable slice of `First_Implementation_Test.md`.

## Prerequisites

- Node.js 24+
- LM Studio with a loaded local model at `http://127.0.0.1:1234/v1`, or vLLM at `http://127.0.0.1:8000/v1`
- OpenCode installed from the workspace dependencies

## Run

```powershell
npm install
npm run desktop:dev
```

The Electron main process owns folder selection, optional Git worktree creation, task metadata, IDE handoff, and approval checks. The first workflow is intentionally narrow: regular folders run in place with a baseline snapshot, while Git repositories can still use an isolated worktree. Aegis runs the hello-world verification loop with visible command events and renders an in-app unified diff review before approval.

`http://127.0.0.1:5173` is only the Vite web preview. It can render the UI, but it cannot use the Electron preload bridge, open folders, or talk to the spawned OpenCode server. Use `npm run desktop:dev` for the actual app.

## Permissions and Sandbox Safety

Normal permissions ask before worktree creation and tool actions. Bypass permissions automatically create the worktree and allow local edit/bash steps for the task, but final merge approval is still manual.

Bypass mode does not bypass IPC validation, provider lockdown, worktree boundaries, blocked-file checks, secret scanning, or final merge approval.

## Implemented

- Hardened Electron shell with sandboxing, context isolation, navigation blocking, window-open blocking, permission denial, strict CSP, and IPC sender validation.
- Minimal typed preload bridge with named task/worktree/approval methods.
- LM Studio or vLLM status check, using the selected loaded local model.
- Worktree lifecycle for the hello-world proof: prompt, worktree, command stream, permission prompts, verification, IDE handoff, explicit approval, checks, merge, metadata, cleanup.
- Approval checks for clean original branch, expected base commit, agent branch base, controlled worktree, latest passing verification, blocked files, secret scan, patch hash, commit, and fast-forward merge.

## Next Phase

- Wire the long-running OpenCode server/SSE contract into the same Aegis task events.
- Add richer IDE detection for Visual Studio and JetBrains products.
- Add repository-specific test configuration after the hello-world proof passes.
