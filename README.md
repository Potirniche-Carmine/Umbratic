# Umbratic

An open-source desktop AI harness for code, files, and documents, released under the [MIT License](LICENSE). Run models locally or connect to your own Veil server.

Umbratic has no usage analytics or automatic telemetry uploads. Local history and diagnostics stay on your device unless you export them. Company server requests and logs are controlled by that server's administrator.

[Downloads](https://github.com/Potirniche-Carmine/Umbratic/releases) · [Website](https://umbratic.ai) · [Issues](https://github.com/Potirniche-Carmine/Umbratic/issues)

Windows installers are currently unsigned. Signing is planned through SignPath Foundation, subject to approval; see the [Code signing policy](CODE_SIGNING_POLICY.md).

## Getting started

Download an available build for macOS 13+ on Apple Silicon or Windows x64/ARM64 from [GitHub Releases](https://github.com/Potirniche-Carmine/Umbratic/releases). Choose and download a model in the app, or build from source below.

### Build and run

Install the Node.js/npm versions in [package.json](package.json), [Rust toolchain](rust-toolchain.toml), [Go version](infrastructure/veil/go.mod), and [Python version](.python-version). Native builds need Xcode Command Line Tools on macOS or MSVC Build Tools and Ninja on Windows. Packaging also needs CMake 3.21+.

```sh
npm ci --ignore-scripts --omit=peer
cargo fetch --locked
npm run dependencies:provision
npm run desktop:dev
```

Build an unsigned local app on the target operating system:

```sh
npm run desktop:release -- --unsigned --dir
```

Output goes to `target/release/desktop`. The app includes Veil and the local runtime; download model weights in the app. Local mode needs no separate server setup.

## Server

Build the standalone Veil gateway:

```sh
cd infrastructure/veil
go build ./cmd/veil
```

See [Veil](infrastructure/veil/README.md) for configuration, or [Veil Console](infrastructure/veil-console/README.md) to build and administer a self-hosted server. In the desktop app, choose **Company server** in Settings and enter the server address and enrollment code.

## Contribute

```sh
npm run test:all
```

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and the [Code signing policy](CODE_SIGNING_POLICY.md). Dependencies, model weights, and inference runtimes retain their own licenses.
