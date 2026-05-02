# Aegis Desktop PoV

This is the first runnable slice of `Local_Gemma_UI_Coding_Agent_POV.md`.

## Prerequisites

- Node.js 24+
- LM Studio with the OpenAI-compatible server enabled at `http://localhost:1234/v1`
- Any chat-capable model loaded in LM Studio
- Docker Sandboxes with the standalone `sbx` CLI, recommended for sandboxed agent runs

## Run

```powershell
npm install
npm run desktop:dev
```

The Electron main process prefers Docker Sandboxes for OpenCode: it creates or reuses an `opencode` sandbox with `sbx`, allows the sandbox to reach LM Studio at `localhost:1234`, starts `opencode serve` inside it, publishes the OpenCode API back to `127.0.0.1`, and points the sandboxed OpenCode config at LM Studio through `host.docker.internal`. If Docker Sandboxes are unavailable, Aegis falls back to running the local `opencode serve` binary directly on the host.

`http://127.0.0.1:5173` is only the Vite web preview. It can render the UI, but it cannot use the Electron preload bridge, open folders, or talk to the spawned OpenCode server. Use `npm run desktop:dev` for the actual app.

## Permissions and Sandbox Safety

Default permissions are designed to run in Docker Sandbox mode when available, keeping OpenCode inside an isolated microVM. Routine project exploration can run without interruption; approvals are reserved for sensitive information gathering and destructive or write actions. The mounted workspace is still real: changes made by the agent appear on your host working tree.

Bypass permissions remove those approval prompts. In Docker Sandbox mode, bypass can still freely change mounted workspace files. In host fallback mode, bypass can give the AI agent full access to your computer, including commands and files outside the project, so there is real risk involved.

## Implemented

- Electron-supervised OpenCode backend with random localhost port and per-launch Basic auth.
- Docker Sandbox OpenCode runtime via `sbx`, with host fallback when sandboxing is unavailable.
- Privacy-locked OpenCode config: LM Studio provider only, sharing disabled, web tools disabled, and cloud provider environment scrubbed.
- LM Studio `/models` resolution for the currently loaded local model.
- Electron + React shell with project picking, OpenCode chat flow, git/diff helpers, IDE helpers, and permission approvals.

## Next Phase

- Tighten OpenCode event rendering for long-running tool calls.
- Expand session history and diff integration directly from OpenCode APIs.
- Add local-only export/debug bundles.
