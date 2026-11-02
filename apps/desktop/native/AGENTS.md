# Desktop Core Map

- `src/main.rs`: Rust file-search CLI and tests.

## Verification

From the repository root:

```sh
cargo test --locked --package umbratic-desktop-core --all-targets
cargo clippy --locked --package umbratic-desktop-core --all-targets -- -D warnings
```
