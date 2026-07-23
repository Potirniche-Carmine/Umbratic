# AGENTS.md

## Repository Map

Umbratic is a hybrid monorepo. It is not an all-Rust application:

- `apps/desktop/` is the Electron, Vite, React, and TypeScript desktop shell. Its `native/` directory contains the small Rust desktop-core helper.
- `packages/runner/` is the production Rust workspace runner. Its Node package exists only to expose repository scripts and run real-process integration tests.
- `infrastructure/veil/` is the Go model gateway. It owns protected prompts, route and model policy, authentication, and private-runtime calls.
- `infrastructure/veil-console/` is the separate administration service for Veil. Development runs on Windows, macOS, and Linux. Production targets Ubuntu 24.04 LTS on `amd64`. Console owns the local owner account, Console sessions, typed Veil configuration, restricted secrets, and direct supervision of one Veil child process.
- `scripts/` contains repository-level TypeScript launch, benchmark, and supply-chain helpers.

The root Cargo workspace contains `apps/desktop/native` and `packages/runner`. The npm workspace coordinates builds, tests, packaging, and the TypeScript portions of the application.

Follow the nearest project-level `AGENTS.md`. Treat each top-level area as a separate project unless the user requests cross-project work or an interface between areas is directly affected. Gather context and make changes only in the relevant area.

## Architecture Boundaries

The supported model path is:

```text
React renderer -> Electron main/preload -> Rust runner -> Veil -> private model runtime
                                  |
                                  -> Rust desktop core for bounded file search
```

The separate administration path is:

```text
Administrator browser -> Veil Console -> supervised Veil process
```

- The renderer owns presentation and user interaction, not privileged filesystem or process access.
- Electron main owns desktop orchestration, narrow IPC, native-process lifecycle, attachments, review, permissions, and local product state.
- The Rust runner owns workspace tools, policy enforcement, execution, session/context management, and the local authenticated HTTP/SSE contract.
- Veil owns all protected model-facing behavior. Neither desktop nor runner may bypass it or call Ollama, vLLM, or another model runtime directly.
- Veil Console owns administrator-facing configuration and process control. It may reach a private runtime only for bounded configuration tests, and it must manage Veil through a fixed binary path, an allowlisted environment, and Veil's authenticated API.
- The Rust desktop core is intentionally narrow. Do not grow it into a second runner.

Keep secrets, protected prompts, provider details, raw sensitive telemetry, and privileged capabilities out of renderer-visible state. Preserve the existing trust boundaries when changing interfaces between projects.

## Dependency And Supply-Chain Rules

Keep outside dependencies as small as practical:

- Prefer the Rust, Go, and Node standard libraries or an existing dependency when the implementation remains clear and safe.
- Add a dependency only when its maintenance, security, and implementation benefit justify the additional transitive graph.
- Keep direct npm versions exact and Cargo builds locked. Do not add Git-sourced packages, lifecycle install scripts, or unreviewed binary downloads.
- Keep Veil on the Go standard library unless a dependency has a documented need. Veil Console can use the reviewed Argon2id, SQLite, and Windows system-call dependencies recorded in its `README.md`.
- When changing dependencies, update the appropriate lockfile and supply-chain policy, inspect the transitive change, and run `npm run supply-chain:check`.
- Never weaken a security or test gate merely to make a dependency update pass.

## Working And Verification Rules

Preserve unrelated user changes and keep edits focused. Do not perform broad cleanup as part of an unrelated task.

## UI Copy Rules

Avoid redundant microcopy: non-essential explanatory text that merely restates a control, exposes implementation details, repeats visible state, or adds decorative status prose. Prefer the shortest useful label and keep helper text only when it changes a user decision or explains an action that is not otherwise clear.

Run focused checks while developing. Before finishing any repository change, run this from the repository root:

```sh
npm run test:all
```

Also run the nearest project-specific build, lint, packaging, or formatting check when the changed behavior is not fully exercised by the root suite.
