# Runner Map

- `src/`: Rust runner, workspace tools, sessions, and Veil transport.
- `src/lsp/`: language-server integration.
- `tests/`: TypeScript integration tests and fixtures.

## Verification

From the repository root:

```sh
npm --workspace @umbratic/runner run test:all
cargo clippy --locked --package umbratic-runner --all-targets -- -D warnings
```
