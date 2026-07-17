# AGENTS.md

## Desktop App

This project is the desktop product shell. Most of it remains Electron, Vite, React, and TypeScript; `native/` is a separate Rust binary for bounded repository file search. Follow `native/AGENTS.md` for work inside that directory.

Keep the shell thin and direct:

- `src/renderer/` owns the React UI and presentation state.
- `src/preload/` exposes a narrow, typed IPC surface. Do not expose general Electron, filesystem, or process primitives.
- `src/main/` owns trusted desktop orchestration, native-process lifecycle, workspace and attachment context, permissions, review flows, event streaming, local state, telemetry redaction, and transport to the Rust runner.
- `native/` owns only the small desktop-core command surface described by its local instructions.
- `scripts/` owns development, build-copy, packaging, and package-verification tasks.

Workspace tool execution belongs in the Rust runner. Do not restore a TypeScript runner or add a Node fallback that silently changes security behavior. Resolve the signed packaged Rust binaries through the existing development and packaged-resource paths.

## Veil Boundary

Veil owns model-facing behavior. Do not add system prompts, hidden behavioral prompts, personas, skill-selection prompts, route-specific guidance, model policy, model selection, or provider/runtime decisions to Electron, the renderer, desktop core, or runner.

Both connection modes go through Veil. Local mode uses the app-managed local Veil process; Server mode uses the hosted Veil service. Never call Ollama, vLLM, or another model runtime directly.

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

Review visual work in the running app at realistic window sizes. Typechecks and source inspection alone are not sufficient visual verification.

## Testing

Add tests at the layer that owns the behavior:

- TypeScript unit and contract tests belong in `tests/*.test.ts`.
- IPC tests must prove that the preload surface is narrow and main-process validation cannot be bypassed.
- Native-process adapter tests should assert malformed output, early exit, cancellation, event ordering, and cleanup rather than only the happy path.
- Packaging changes must verify that both Rust binaries are present, executable, and launchable from packaged resources.

Run focused checks first. Before finishing, run `npm run test:all` from the repository root. Also run `npm run desktop:build` for desktop changes. When packaged-resource behavior changes, run `npm --workspace @umbratic/desktop run package` followed by `npm --workspace @umbratic/desktop run verify:package`.

Clean up dev servers, Electron processes, preview servers, native helpers, and watchers before ending the task.
