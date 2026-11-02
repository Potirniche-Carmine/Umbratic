# Desktop Map

- `src/renderer/`: React UI.
- `src/preload/`: IPC bridge.
- `src/main/`: Electron main process.
- `src/shared/`: shared types and contracts.
- `native/`: Rust file-search helper.
- `tests/`: TypeScript tests.
- `scripts/`: development, build, and packaging helpers.

## Verification

From the repository root:

```sh
npm --workspace @umbratic/desktop run test:all
npm --workspace @umbratic/desktop run build
```

For packaging changes, also run the desktop workspace's `package` and `verify:package` scripts.
