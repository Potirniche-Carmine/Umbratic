# Umbratic

Umbratic is a private AI workbench for teams running local or company-managed model infrastructure. The desktop app talks to a local runner for workspace tools, and the runner talks to Veil, the authenticated model boundary in front of the model runtime: an app-managed llama.cpp sidecar in local mode, or Console-managed vLLM processes in server mode.

Umbratic is not a public connector platform. The supported harness surface is intentionally small: local workspace tools, local skills, Veil-owned prompts, worktree review, approval flows, and redacted operational telemetry retained on company-managed servers.

## Project Structure

- `apps/desktop/` - Electron/Vite/React TypeScript shell plus the native Rust desktop core in `native/`.
- `packages/runner/` - native Rust runner with the fixed workspace tool loop.
- `infrastructure/veil/` - Go service that owns auth, protected prompts, route policy, model configuration, and runtime calls.

## Getting Started

Install the exact Node.js and Rust versions declared by `.nvmrc` and
`rust-toolchain.toml`, plus Go 1.26.5. Install only the locked JavaScript and
Rust dependencies, then explicitly provision Electron's checksum-verified
runtime:

```sh
npm ci --ignore-scripts
cargo fetch --locked
npm run dependencies:provision
```

Normal development and build commands do not download the Electron runtime.
Run the explicit provisioning command again after an approved Electron update.

Run the desktop app in development:

```sh
npm run desktop:dev
```

Build the shippable application for the machine you are on. This compiles every
binary, bundles Veil into the app, and writes the installers and the
no-installer builds to `target/release/desktop`:

```sh
npm run desktop:release
```

On Windows this produces `Umbratic-<version>-<arch>.exe` (installer). On macOS
it produces `Umbratic-<version>.dmg` and `Umbratic-<version>.zip`, which unzips
to `Umbratic.app`. Each build runs on its own platform; electron-builder cannot
produce a macOS app from Windows or the reverse. Signing, notarization, and
publishing to `downloads.umbratic.ai` — where installed apps look for updates
— are covered in [docs/guides/release-desktop.md](docs/guides/release-desktop.md).

Both carry their own Veil binary, so a packaged app runs with no install script
and no separate Veil process to start.

Local is the first-run default, and you can switch between Local and Company
server in Settings. In Local mode the desktop owns the Veil process and supplies
its configuration at launch. Packaged users do not need a Veil `.env` file.

In Company server mode, an administrator creates an assigned user in Veil Console
and gives the user one Enrollment code. The desktop uses the code once to enroll
one device. It then uses a device key and short sessions. A shared company bearer
token cannot access chat or telemetry.

See [`docs/guides/deploy-customer.md`](docs/guides/deploy-customer.md) to build
a customer release and install it, and
[`docs/guides/operate-server.md`](docs/guides/operate-server.md) for entitlement
changes, backup, and recovery.

See [`docs/reference/storage.md`](docs/reference/storage.md) for desktop and
server installation, state, cache, and log locations.

Run Veil by itself for server development:

```sh
npm run veil:dev
```

Run the full test suite:

```sh
npm run test:all
```

Dependency update, audit, runtime provisioning, and SBOM rules are documented in
[`docs/reference/supply-chain.md`](docs/reference/supply-chain.md).
