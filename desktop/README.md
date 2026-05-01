# Aegis Desktop PoV

This is the first runnable slice of `Local_Gemma_UI_Coding_Agent_POV.md`.

## Prerequisites

- Node.js 24+
- Rust toolchain with Cargo
- LM Studio with the OpenAI-compatible server enabled at `http://localhost:1234/v1`
- `google/gemma-4-E4B-it` loaded in LM Studio for the default chat path

## Run

```powershell
npm install
npm run daemon:build
npm run desktop:dev
```

The Electron main process starts `aegis-app`, reads the daemon startup JSON line from stdout, and passes the local WebSocket URL/token to the renderer.

`http://127.0.0.1:5173` is only the Vite web preview. It can render the UI, but it cannot use the Electron preload bridge, open folders, or talk to the spawned daemon. Use `npm run desktop:dev` for the actual app.

## Implemented

- Rust daemon workspace with protocol, model, store, core, tools, and app crates.
- Random localhost WebSocket port with per-launch auth token.
- SQLite schema and local app data database.
- LM Studio `/models`, `/chat/completions`, and `/embeddings` client surface.
- JSON-RPC methods for health, model listing, a bounded chat task, IDE detection, and git status.
- Electron + React shell with model health, tool timeline, trace details, and chat task flow.

## Next Phase

- Project registry and folder picker.
- Tool schema injection with `fs.read`, `fs.list`, and `fs.propose_patch`.
- Monaco diff review surface.
- LanceDB-backed semantic indexing with lexical fallback.
