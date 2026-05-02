# Aegis Desktop PoV

This is the first runnable slice of `Local_Gemma_UI_Coding_Agent_POV.md`.

## Prerequisites

- Node.js 24+
- LM Studio with the OpenAI-compatible server enabled at `http://localhost:1234/v1`
- Any chat-capable model loaded in LM Studio

## Run

```powershell
npm install
npm run desktop:dev
```

The Electron main process starts `opencode serve` on `127.0.0.1`, generates a locked local LM Studio provider config, and passes the authenticated OpenCode connection to the renderer.

`http://127.0.0.1:5173` is only the Vite web preview. It can render the UI, but it cannot use the Electron preload bridge, open folders, or talk to the spawned OpenCode server. Use `npm run desktop:dev` for the actual app.

## Implemented

- Electron-supervised OpenCode backend with random localhost port and per-launch Basic auth.
- Privacy-locked OpenCode config: LM Studio provider only, sharing disabled, web tools disabled, and cloud provider environment scrubbed.
- LM Studio `/models` resolution for the currently loaded local model.
- Electron + React shell with project picking, OpenCode chat flow, git/diff helpers, IDE helpers, and permission approvals.

## Next Phase

- Tighten OpenCode event rendering for long-running tool calls.
- Expand session history and diff integration directly from OpenCode APIs.
- Add local-only export/debug bundles.
