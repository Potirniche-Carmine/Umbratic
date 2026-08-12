# AGENTS.md

## Desktop App

This project is the desktop product shell: Electron, Vite, React, and TypeScript. `native/` is a separate Rust binary for bounded repository file search — follow `native/AGENTS.md` for work inside that directory.

Keep the shell thin and direct:

- `src/renderer/` owns the React UI and presentation state.
- `src/preload/` exposes a narrow, typed IPC surface. Do not expose general Electron, filesystem, or process primitives.
- `src/main/` owns trusted desktop orchestration, native-process lifecycle, workspace and attachment context, permissions, review flows, event streaming, local state, telemetry redaction, and transport to the Rust runner.
- `native/` owns only the small desktop-core command surface described by its local instructions.
- `scripts/` owns development, build-copy, packaging, and package-verification tasks.

The other Rust helpers live outside this project and are invoked as child processes: `umbratic-pdf` for PDF text, `umbratic-code-index` for the workspace-graph artifact.

Workspace tool execution belongs in the Rust runner. Do not restore a TypeScript runner or add a Node fallback that silently changes security behavior. Resolve the signed packaged Rust binaries through the existing development and packaged-resource paths.

## Remote Hosts

A chat may run its tools on another machine over SSH. `sshTransport.ts` drives the system OpenSSH client as a child process — nothing here implements the protocol — and every invocation sets its guarantees on the command line, where OpenSSH resolves them ahead of any `ssh_config`. `remoteConnections.ts` owns saved hosts, `remoteHost.ts` owns what is asked of a host, `remoteRunner.ts` starts a run there, and `remoteService.ts` is the surface the settings page drives.

The rules that make this safe are not optional:

- A credential is never offered to a host whose key the user has not seen and approved. Host keys live in Umbratic's own `known_hosts`, and every working connection uses `StrictHostKeyChecking=yes` against it.
- Remote commands are built as argument lists and quoted for the remote shell. Never concatenate a path or a user value into a command line.
- The runner still binds loopback on the host it runs on. An `ssh -L` forward reaches it and an `ssh -R` forward carries the local Veil back, so model traffic stays inside the SSH channel and no listener is exposed on either network.
- The runner's configuration is one line on stdin and stdin stays open for the session. Closing it is how a remote runner learns the desktop is gone; a caller that closes stdin early gets an immediate shutdown, which is the contract, not a bug.
- Only a platform-matched runner artifact is installed, verified by checksum on the remote host after transfer. A remote runner whose checksum does not match this build reads as not installed.
- A remote task has no local workspace. Checkpoints, local review, the workspace graph, and attachment directories do not apply to it, and its capability report describes the remote host rather than this one.

## Veil Boundary

Veil owns model-facing behavior. Do not add system prompts, hidden behavioral prompts, personas, skill-selection prompts, route-specific guidance, model policy, model selection, or provider/runtime decisions to Electron, the renderer, desktop core, or runner.

Both connection modes go through Veil. Local mode uses the app-managed local Veil process; Server mode uses the hosted Veil service. Never call Ollama, vLLM, or another model runtime directly.

Picking a model from the registry Veil publishes is a route choice of the same kind, not a runtime decision: the desktop names an id Veil already offered on `/api/models`, and Veil decides what that id means and where it goes. Never derive a model list from a runtime, and never send `model` to a server that has not advertised `chat.model_selection` — a server without a registry refuses the field rather than ignoring it.

The desktop may select an explicit product route requested by the user. Veil owns the prompt and model behavior behind that route. Client-to-model content is limited to user content and factual local context such as workspace facts, repository instructions, attachments, conversation history, capability results, and tool results. Keep context envelopes neutral.

Enabled skills are an index, not pre-injected instructions. The desktop may send validated skill id, name, description, and source metadata and expose the local `read_skill` tool. Never preselect skills with desktop heuristics or inject full skill bodies from the shell.

Keep provider credentials, protected prompts, route policy, model details, and raw sensitive values out of renderer-visible state, logs, and user-facing diagnostics. The runner must reject client system-prompt overrides; the desktop must not attempt them.

## IPC And Native Processes

Treat renderer input, workspace content, native-process output, and server responses as untrusted:

- Validate IPC arguments in the main process and return stable, non-sensitive errors.
- Keep workspace operations within the selected root and preserve path, symlink, generated-file, and secret-file protections.
- Require the runner's loopback authentication and do not broaden its listener or expose credentials to the renderer.
- Preserve event ordering and terminal-state semantics when adapting runner streams for the UI.
- Clean up runner, Veil, worker, and desktop-core processes on shutdown and failed startup.
- Keep stdout machine-readable when invoking native helpers; route diagnostics to stderr.

## Design

Design and UI/UX quality are first-order product requirements. Use clear hierarchy, restrained visual language, excellent typography and spacing, obvious affordances, thoughtful defaults, and complete state design.

Keep the experience calm, fast, and intentional. Avoid configuration-heavy UI, developer-centric terminology, duplicated controls, and surfaces that expose Veil or runner internals instead of the user's task. Avoid layout shift by reserving space, overlaying transient UI, or scrolling within fixed regions.

Use semantic colors consistently and do not use emoji in product UI. For visual changes, verify light and dark mode plus relevant hover, focus, pressed, disabled, open, closed, empty, loading, success, and error states. Check keyboard navigation, accessible names, contrast, responsive sizing, truncation, overflow, and reduced motion.

Review visual work in the running app at realistic window sizes. Typechecks and source inspection alone are not sufficient visual verification. `npm run dev:web` from this directory serves `preview.html`, which boots the renderer against the fixtures in `src/renderer/previewEnvironment.ts` with no Electron — enough to look at composer and review states without a live Veil.

## Testing

Add tests at the layer that owns the behavior:

- TypeScript unit and contract tests belong in `tests/*.test.ts`. They load main-process modules directly through `tests/helpers/load-ts-module.ts` with mocked Electron, so values that cross that boundary need `JSON.parse(JSON.stringify(...))` before `deepEqual`.
- IPC tests must prove that the preload surface is narrow and main-process validation cannot be bypassed. A new API method needs its channel added in `src/shared/desktopApi.ts`, `src/preload/preload.ts`, the `main.ts` handler map, and the `preload-ipc` table, or it fails at one of the four.
- Native-process adapter tests should assert malformed output, early exit, cancellation, event ordering, and cleanup rather than only the happy path.
- Packaging changes must verify that the packaged Rust binaries are present, executable, and launchable from packaged resources. `prepare-package.ts` copies four — runner, desktop-core, pdf, code-index — and `verify-package.ts` launches the first three.

Run focused checks first. Before finishing, run `npm run test:all` from the repository root. Also run `npm --workspace @umbratic/desktop run build` for desktop changes. When packaged-resource behavior changes, run `npm --workspace @umbratic/desktop run package` followed by `npm --workspace @umbratic/desktop run verify:package`.

Clean up dev servers, Electron processes, preview servers, native helpers, and watchers before ending the task.
