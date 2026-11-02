# Repository Map

| Path | Contents |
| --- | --- |
| `apps/desktop/` | Electron, React, and TypeScript desktop app |
| `apps/desktop/native/` | Rust file-search helper |
| `packages/runner/` | Rust workspace runner |
| `packages/code-index/` | Rust workspace-graph producer |
| `packages/pdf/` | Rust PDF text extractor |
| `packages/artifacts/` | Rust spreadsheet sidecar |
| `infrastructure/veil/` | Go model gateway |
| `infrastructure/veil-console/` | Go administration service |
| `scripts/` | Repository build, test, and release helpers |

## Verification

For code changes, run `npm run test:all` from the repository root.
Run the nearest relevant build, lint, packaging, or formatting check if the root suite does not cover the change.
