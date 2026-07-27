# AGENTS.md

## Rust Runner

`packages/runner` is the production Rust workspace runner. `package.json` only coordinates Cargo and the TypeScript real-process integration tests; do not add a JavaScript or TypeScript production fallback.

The runner owns:

- `server.rs`: authenticated loopback HTTP/SSE boundary and request validation.
- `config.rs`: validated launch configuration and approved Veil routes.
- `provider.rs`: Veil-only model transport and stream decoding.
- `loop_runtime.rs`: assistant/tool loop and lifecycle ordering.
- `policy.rs`, `permission.rs`, and `tools.rs`: workspace safety, approval, and execution.
- `context.rs` and `session.rs`: bounded context, history, cancellation, and session state.
- `events.rs` and `diagnostics.rs`: stable external contracts and redacted diagnostics.
- `workspace_graph.rs`: bounded workspace relationship data.
- `lsp/`: probe-gated, read-only language-server lifecycle, protocol framing, and workspace-relative code-intelligence results.

Keep modules cohesive and keep security decisions at the boundary that has enough information to enforce them.

## Security And Contract Invariants

These are required behavior, not optional hardening:

- Bind only to an explicit loopback IP address. Do not accept hostnames or non-loopback listeners.
- Require authentication on runner endpoints, keep responses non-cacheable, and enforce request/body limits.
- Send every model request through an approved Veil route. Never call Ollama, vLLM, or another runtime directly.
- Reject system-prompt and protected model overrides at every accepted input shape, including nested or compatibility forms.
- Treat all workspace paths and tool arguments as untrusted. Enforce canonical-root, traversal, symlink, secret, generated-file, and command-policy checks before execution.
- Policy denial happens before a permission request. Permission approval never overrides policy.
- Each requested tool call receives one `tool.requested` event and one terminal outcome. Preserve stable ordering, ids, error codes, cancellation, and process cleanup on every failure path.
- Reject duplicate call and message ids where ambiguity could corrupt history or lifecycle state.
- Keep context and history bounded, including complete tool lifecycles during compaction.
- Redact secrets, credentials, prompt content, raw command output, and absolute paths from diagnostics. Do not panic on untrusted network, model, or workspace input.

Avoid `unsafe`; if an operating-system boundary requires it, isolate it, document the invariant, and cover the surrounding behavior with tests.

## Dependencies

Prefer the Rust standard library or an existing crate. Before adding a crate, confirm that the behavior cannot be implemented clearly with the current graph, inspect default features and transitive packages, disable unused features, and keep `Cargo.lock` current. Do not add Git dependencies or build-time downloads.

## Testing

Tests must prove the contract, not just execute code:

- Use table-driven boundary cases for invalid, empty, zero, maximum, oversized, duplicate, traversal, symlink, and malformed input.
- Assert full event sequences and terminal outcomes; do not accept tests that return early before the behavior under test is observed.
- Exercise split UTF-8 and split JSON/SSE chunks, provider disconnects, cancellation, denied policy, denied permission, tool failure, and process-tree cleanup where relevant.
- Use realistic workspace data. A fixture should be possible under actual policy and filesystem rules.
- Keep unit tests close to Rust modules. Keep `tests/native-runner.test.ts` as a black-box test that launches the real compiled binary.
- Do not ignore, conditionally skip, or silently pass a security or contract test because an external service is unavailable. Use local deterministic fakes at the transport boundary.

Run:

```sh
cargo test --locked --package umbratic-runner --all-targets
cargo clippy --locked --package umbratic-runner --all-targets -- -D warnings
npm --workspace @umbratic/runner run test:all
npm run test:all
```
