# Aegis Project Status

Aegis is a local-first Electron desktop app for running coding-agent tasks in a
controlled workspace. The intended product flow is:

1. Pick a repository or folder.
2. Ask for a code change in chat.
3. Aegis creates an isolated task workspace.
4. OpenCode runs the agent harness and tool calls.
5. LM Studio or vLLM serves the local LLM through an OpenAI-compatible endpoint.
6. The user reviews the result and explicitly approves the merge or keeps the
   worktree.


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

## Run

```powershell
npm install
npm run desktop:dev
```

Use the Electron app for real task flows. The Vite browser preview can show the
UI, but it cannot use the preload bridge, pick folders, run commands, or talk to
the local agent backend.

## Known UI Stubs

These settings surfaces are wired up visually but are not yet enforced at
runtime. They need to be implemented:

- **Settings → Tools** — toggling `read`, `write`, `edit`, `search`, or
  `command` does not yet filter the runner's `toolSpecs`. The runner still
  exposes every tool to the model; the UI toggles are local React state only.
- **Settings → Account → Continue with Google / Microsoft** — SSO buttons are
  UI placeholders. Aegis runs entirely in local mode today.
- **Settings → Skills (Managed section)** — server/company-managed skills are
  not yet delivered from a remote source; the section currently shows an empty
  state describing the planned behavior.
- **Settings → Skills (Your skills toggles)** — per-skill enable toggles are
  local React state. Loading skills from `~/.aegis/skills/`, the **Open folder**
  button, and **New skill** scaffolding are all real.
