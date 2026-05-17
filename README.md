# Aegis Project Status

Aegis is a local-first Electron desktop app for running coding-agent tasks in a
controlled workspace. The intended product flow is:

1. Pick a repository or folder.
2. Ask for a code change in chat.
3. Aegis creates an isolated task workspace.
4. The bundled Aegis runner runs the agent harness and tool calls.
5. A configured OpenAI-compatible endpoint serves the model.
6. The user reviews the result and explicitly approves the merge or keeps the
   worktree.


## Security Model

The security goal is to keep the renderer UI untrusted and make the Electron
main process, plus its spawned local runner, the only trusted pieces that can
touch the filesystem, shell, Git, or IDE handoff.

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

The desktop UI does not require a host toolchain just to render or run in
development. The backend knows to prefer helper tools such as `rg`,
`fd`/`fdfind`, `tree-sitter`, and `bat`/`batcat` when they are available, and to
fall back cleanly when they are not. `jq`, `yq`, `cmake`, C compilers, build
backends, and native debuggers are optional capabilities the harness can use
when present. A future packaged installer can bundle these helpers or offer to
install them for the user.

Use the Electron app for real task flows. The Vite browser preview can show the
UI, but it cannot use the preload bridge, pick folders, run commands, or talk to
the local agent backend.

## mTLS Direct Endpoint Plan

`Comm_Option_mTLS_Direct.md` can be implemented in two phases. The local phase
proves that Aegis can talk to an OpenAI-compatible endpoint over mutually
authenticated TLS. The server phase swaps the disposable local certs and mock
endpoint for production PKI material and the internal model host.

Needed for production:

- Private CA with an offline root and online intermediate.
- Server certificate for the internal model hostname, such as
  `ai.company.internal`.
- Client certificate issued to the Aegis device or user.
- Reverse proxy in front of the model endpoint that requires client certs.
- Revocation story: short-lived client certs plus a server-side kill list or
  CRL/OCSP.
- Aegis credential storage: PFX/file config for local testing, then OS
  keychain or TPM/Secure Enclave-backed keys for production.
- Optional server certificate pin via `AEGIS_MODEL_TLS_PIN_SHA256`.

What is already supported locally:

- Main-process `/models` healthcheck over HTTPS with client certs.
- Runner chat-completion streaming over HTTPS with client certs.
- Local cert generation and an mTLS OpenAI-compatible mock endpoint.
- Future internal endpoint allowlist for `https://ai.*.internal` when mTLS
  config is present.

When the real server is available, keep the same environment variable shape and
replace only the local values: `AEGIS_MODEL_BASE_URL`, CA path, client
credential path, passphrase or keychain-backed credential, optional server name,
and optional pin.

## Local mTLS Endpoint Smoke Test

The OpenAI-compatible endpoint can be reached over HTTPS with a client
certificate. This is the local stand-in for `Comm_Option_mTLS_Direct.md`; it
uses disposable test certs under `.aegis/`.

```powershell
npm run mtls:certs
npm run mtls:mock
```

In another shell, start Aegis against the mock endpoint:

```powershell
$env:AEGIS_MODEL_BASE_URL='https://localhost:9443/v1'
$env:AEGIS_MODEL_ID='aegis-mtls-local'
$env:AEGIS_MODEL_MTLS_CA_PATH='C:\path\to\Aegis\desktop\.aegis\mtls-local\ca.pem'
$env:AEGIS_MODEL_MTLS_PFX_PATH='C:\path\to\Aegis\desktop\.aegis\mtls-local\client.pfx'
$env:AEGIS_MODEL_MTLS_PASSPHRASE='aegis-local-mtls'
npm run desktop:dev
```

For a real server later, keep the same variables but replace the base URL, CA,
client credential, and optional `AEGIS_MODEL_TLS_SERVER_NAME` /
`AEGIS_MODEL_TLS_PIN_SHA256` values with the issued production material.

## Known UI Stubs

These settings surfaces are wired up visually but are not yet enforced at
runtime. They need to be implemented:

- **Settings → Tools** — toggling `read`, `write`, `edit`, `search`,
  `command`, or `debugger` does not yet filter the runner's `toolSpecs`. The runner still
  exposes every tool to the model; the UI toggles are local React state only.
- **Settings → Account → Continue with Google / Microsoft** — SSO buttons are
  UI placeholders. Aegis runs entirely in local mode today.
- **Settings → Skills (Managed section)** — server/company-managed skills are
  not yet delivered from a remote source; the section currently shows an empty
  state describing the planned behavior.
- **Settings → Skills (Your skills toggles)** — per-skill enable toggles are
  local React state. Loading skills from `~/.aegis/skills/`, the **Open folder**
  button, and **New skill** scaffolding are all real.
