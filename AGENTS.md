# AGENTS.md

## How To Work Here

1. Read the nearest project-level `AGENTS.md` before editing that area.
2. Change only what the task needs. Leave unrelated code alone.
3. Choose the simplest implementation that satisfies the requirements. Prefer deleting and replacing over layering. Do not add abstractions, options, or helpers "just in case."
4. Never preserve or implement backward compatibility. Update callers and contracts to the new shape; do not keep dual paths, shims, aliases, or compatibility flags.
5. Prefer the standard library or an existing dependency. Add a new dependency only when the benefit clearly outweighs the supply-chain cost.
6. Keep secrets, protected prompts, provider details, and privileged capabilities out of renderer-visible state.
7. Stop every process you started before ending a turn.

## Repository Map

Umbratic is a hybrid monorepo:

| Path | Role |
| --- | --- |
| `apps/desktop/` | Electron / React / TypeScript shell; `native/` is a small Rust file-search helper |
| `packages/runner/` | Production Rust workspace runner |
| `infrastructure/veil/` | Go model gateway: auth, prompts, route/model policy, runtime calls |
| `infrastructure/veil-console/` | Admin service that configures and supervises one Veil process |
| `scripts/` | Repo-level launch, benchmark, and supply-chain helpers |

Treat each top-level area as its own project unless the task crosses an interface between them.

## Architecture

```text
React renderer -> Electron main/preload -> Rust runner -> Veil -> private model runtime
                                  |
                                  -> Rust desktop core (bounded file search)

Administrator browser -> Veil Console -> supervised Veil process
```

- Renderer: presentation only. No privileged filesystem or process access.
- Electron main: orchestration, IPC, permissions, local product state, runner/Veil lifecycle.
- Runner: workspace tools, policy, execution, session/context, authenticated HTTP/SSE.
- Veil: all protected model-facing behavior. Desktop and runner never call Ollama, vLLM, or another runtime directly.
- Veil Console: admin config and Veil process control only.
- Desktop core: file search only. Do not grow it into a second runner.

## Dependencies

- Keep direct npm versions exact and Cargo builds locked.
- No Git-sourced packages, lifecycle install scripts, or unreviewed binary downloads.
- Keep Veil on the Go standard library unless a dependency has a documented need.
- After dependency changes: update the lockfile/policy, inspect the transitive graph, run `npm run supply-chain:check`.
- Never weaken a security or test gate to land a dependency update.

## UI Copy

Prefer the shortest useful label. Keep helper text only when it changes a decision or clarifies an otherwise unclear action. Avoid restating visible state or exposing implementation details.

## Verification

Run focused checks while developing. Before finishing any repository change:

```sh
npm run test:all
```

Also run the nearest project build, lint, packaging, or formatting check when the root suite does not cover the changed behavior.
