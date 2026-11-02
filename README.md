# Umbratic

An open-source AI harness for working with code, files, and documents. Run models on your computer or connect to a Veil server on your own infrastructure.

[Download the desktop app](https://github.com/Potirniche-Carmine/Umbratic/releases) · [Website](https://umbratic.ai) · [Documentation](docs/README.md) · [Report an issue](https://github.com/Potirniche-Carmine/Umbratic/issues)

## What you can do

- Search and edit workspace files, run commands, and work with code in Git worktrees.
- Use built-in skills for documents, spreadsheets, presentations, PDFs, and other tasks, or add local skills.
- Review code changes and document drafts, give feedback, and control actions through permissions and approvals.
- Run local inference through the bundled Veil gateway, or enroll a device with a company-managed Veil server.

## Privacy

Umbratic has no usage analytics or automatic telemetry uploads. Task history and diagnostic logs stay on your device; you can export logs when troubleshooting.

Local mode runs inference on your computer. Company server mode sends model requests to the Veil server you configure, where the administrator controls access, runtime infrastructure, and server logs. That deployment determines its own retention policy.

Model downloads, application release checks, server enrollment, and explicitly used web search require network access. Commands you approve may also use the network. See [storage locations](docs/reference/storage.md) for local and server state.

## Getting started

Download an available build for macOS 13 or later on Apple Silicon, Windows x64, or Windows ARM64 from [GitHub Releases](https://github.com/Potirniche-Carmine/Umbratic/releases). Local mode is the first-run default. Choose and download a model in the app; the download size and hardware requirements depend on the model.

For shared infrastructure, follow the [self-hosted server guide](docs/guides/deploy-customer.md). An administrator runs Veil Console and Veil, adds models, and provides an enrollment code. Select **Company server** in Settings to enroll your device.

## Build from source

Install Node.js and npm at the versions in [package.json](package.json), Rust from [rust-toolchain.toml](rust-toolchain.toml), and Go from [infrastructure/veil/go.mod](infrastructure/veil/go.mod). Platform builds also require the native toolchain for that operating system. Repository checks require patched Python: 3.12.16+, 3.13.18+, 3.14.10+ or 3.15.2+ within those release series. CI pins [.python-version](.python-version).

Install locked dependencies and explicitly provision the checksum-verified Electron runtime:

```sh
npm ci --ignore-scripts --omit=peer
cargo fetch --locked
npm run dependencies:provision
```

Start the desktop app:

```sh
npm run desktop:dev
```

Build an unsigned local application for the machine you are on:

```sh
npm run desktop:release -- --unsigned --dir
```

Build outputs go to `target/release/desktop`. Each operating system is built on that platform. Packaged applications include Veil and the local inference runtime; users do not need to start Veil separately or create a Veil `.env` file. Image generation includes its own runtime on supported platforms. Download model weights separately in the app.

See [desktop releases](docs/guides/release-desktop.md) for signing, packaging, and GitHub publication, the [Code signing policy](CODE_SIGNING_POLICY.md) for signing scope and status, and [supply-chain rules](docs/reference/supply-chain.md) for dependency updates, audits, and SBOMs.

## Architecture

```text
Desktop UI → Electron main → Rust runner → Veil → model runtime
                    ↓
            Rust file search

Administrator browser → Veil Console → Veil + managed model processes
```

| Path | Purpose |
| --- | --- |
| `apps/desktop/` | Electron, React, and TypeScript app; Rust file-search helper in `native/` |
| `packages/runner/` | Rust workspace tools, permissions, task execution, and context |
| `packages/code-index/` | Workspace graph producer |
| `packages/pdf/` | PDF text extraction |
| `packages/artifacts/` | Rust spreadsheet creation, inspection, and editing sidecar |
| `infrastructure/veil/` | Model gateway, authentication, prompts, routing, and runtime calls |
| `infrastructure/veil-console/` | Self-hosted administration and service supervision |
| `scripts/` | Build, release, verification, and supply-chain tooling |

The renderer handles presentation. Privileged file and process access stays in Electron main and the runner. Model calls pass through Veil in both local and server modes.

## Development

Run the full verification suite before submitting code changes:

```sh
npm run test:all
```

Run Veil or Veil Console separately for server development:

```sh
npm run veil:dev
npm run veil-console:dev
```

Read [AGENTS.md](AGENTS.md) for repository conventions and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## License

Umbratic is released under the [MIT License](LICENSE). Third-party dependencies, model weights, and inference runtimes retain their own licenses.
