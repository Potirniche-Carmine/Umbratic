# AGENTS.md

## Rust Desktop Core

`umbratic-desktop-core` is a deliberately small Rust command-line helper used by Electron for bounded repository file search. It is not the workspace runner and must not acquire model transport, tool execution, permission, session, prompt, or general IPC responsibilities.

The current public command is `search-files`. Keep stdout as valid machine-readable JSON on success and send diagnostics only to stderr. Return a nonzero exit status for invalid commands, missing required arguments, and operational failures.

## Filesystem Safety

Treat the root, query, file names, and file contents as untrusted:

- Canonicalize and require a directory root before searching.
- Never follow symlinks or allow results outside the selected root.
- Preserve blocked secret paths and ignored generated/vendor directories.
- Keep content reads size-bounded, skip binary files, and cap result counts.
- Do not panic or emit absolute paths and file contents in normal results.
- Keep ordering deterministic so UI behavior and tests are stable.

Prefer the standard library and the existing dependencies. A new crate needs a concrete safety or maintainability benefit and a review of its transitive graph.

## Testing

Tests must exercise real temporary filesystem trees and include path matches, content matches, deterministic ranking, limits, missing/non-directory roots, ignored directories, secret paths, binary and oversized files, symlinks, and malformed arguments when relevant. Do not replace boundary coverage with mocks or allow silent early returns to count as successful behavior.

Run:

```sh
cargo test --locked --package umbratic-desktop-core --all-targets
cargo clippy --locked --package umbratic-desktop-core --all-targets -- -D warnings
npm run test:all
```

Run the desktop package verification as well when the binary name, location, arguments, or output contract changes.
