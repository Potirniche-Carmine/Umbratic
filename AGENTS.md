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
| `packages/code-index/` | Rust producer for the workspace-graph artifact the runner reads |
| `packages/pdf/` | Rust PDF text extractor, used by the desktop and by Console document ingestion |
| `infrastructure/veil/` | Go model gateway: auth, prompts, route/model policy, runtime calls |
| `infrastructure/veil-console/` | Admin service that configures and supervises one Veil process, and the vLLM process per managed model |
| `scripts/` | Repo-level launch, build, benchmark, supply-chain, and CI helpers |

The Cargo workspace is `apps/desktop/native` plus the three `packages/` crates.

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
- Veil: all protected model-facing behavior. Desktop and runner never call Ollama, vLLM, or another runtime directly. Choosing among the models Veil publishes is a product route choice, not a runtime decision: the list comes from Veil and the id means whatever Veil says it means.
- Veil Console: admin config and Veil process control only.
- Desktop core: file search only. Do not grow it into a second runner.

## Wire Compatibility

Veil is released independently of the harness that calls it. The contract between them:

- **Veil rejects on bounds and privacy only, never vocabulary.** Size caps, count caps, well-formedness, and the privacy deny-list are enforced. Unknown tool-schema keywords, unknown skill fields, unknown `harness_bucket` values, unknown telemetry event types, and unknown body fields are accepted — stripped or defaulted and counted, never rejected.
- **Harness changes are additive.** A newer harness may send fields an older Veil has never seen; that request must still succeed.
- **Capability discovery is by feature name, never by version.** `/api/health` returns `features: []string`. Clients gate server-cooperation features on membership in that list. A missing field means "no features"; a 404 means the capability is absent.
- **A "major shift" — transport or auth change — is a coordinated server release**, not a field addition. Only these justify breaking older harnesses.

Two disciplines follow from this and are not negotiable:

1. **Security-semantic fields are never sent optimistically.** If a field changes authorization, redaction, or safety behavior, the client must confirm the server advertises the feature before sending it. Silent no-op on an older server is a security regression, not graceful degradation.
2. **Bounds are never relaxed client-side to make a payload fit.** If a payload exceeds a cap, shrink the payload. Raising a limit is a server-side decision with its own review.

The golden fixture suite in `infrastructure/veil/internal/policy` encodes this guarantee: "future harness" requests must pass. Every future harness change adds a fixture.

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

Two things the root suite does not cover on Windows: `go test -race` is skipped because CGO is off, so run it on Linux or WSL when Go concurrency changed; and `scripts/check-source-size.ts` gates file length, with `apps/desktop/src/renderer/main.tsx` and `apps/desktop/tests/renderer-markdown.test.ts` already over budget. Leave those two no worse than you found them.
