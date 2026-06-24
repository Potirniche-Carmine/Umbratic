# AGENTS.md

This is a monorepo. Treat each top-level area as a separate project unless the user explicitly asks for cross-project work:

- `apps/desktop/` - Electron desktop app
- `packages/runner/` - local runner package
- `infrastructure/veil/` - Go Veil service

Only gather context and make changes in the project needed for the task. Do not search, inspect, or edit other project directories unless the request names them or the dependency is directly relevant.

Keep changes focused and avoid broad cleanup. Follow the nearest project-level `AGENTS.md` when one exists.
