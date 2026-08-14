# Supply-chain policy

Umbratic treats dependency changes as security changes. The repository uses only
locked crates.io and npm registry packages, keeps Veil on the Go standard
library, and makes executable downloads explicit.

## Reproducible setup

Use the exact Node.js and Rust versions declared in `.nvmrc` and
`rust-toolchain.toml`, plus the Go version declared in
`infrastructure/veil/go.mod`.

```sh
npm ci --ignore-scripts
cargo fetch --locked
npm run dependencies:provision
```

The last command is intentionally separate. It runs the install program from
the exact, registry-integrity-checked Electron package and verifies Electron's
published checksum before making the runtime available. Development and
packaging fail if the runtime was not provisioned. Electron Builder uses that
local distribution rather than downloading a second copy.

All Cargo builds must pass `--locked`. After `cargo fetch --locked`, CI runs the
ordinary build and test graph with `CARGO_NET_OFFLINE=true`. Electron Builder
may still retrieve its platform packaging toolset; those tool archives and
checksums are fixed by the exact Electron Builder package and should be treated
as part of an Electron Builder update review.

## Bundled llama.cpp runtime

Local mode runs `llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp),
built from source during desktop packaging at the commit recorded in
`third_party/llama.cpp.pin`. No prebuilt release archive is downloaded. The
packaging step refuses to continue when the cloned tag does not resolve to the
pinned SHA, and `verify:package` asserts the packaged executable reports the
pinned build number.

Build machines need, in addition to the toolchains above:

- CMake 3.21 or newer.
- Windows: MSVC Build Tools 2022 and the Vulkan SDK, with `VULKAN_SDK` set.
  The SDK supplies headers and `glslc` at build time only; at runtime
  `vulkan-1.dll` comes from the user's display driver, so nothing is bundled.
- macOS: Xcode Command Line Tools. Metal is built in.

`-DLLAMA_CURL=OFF` removes llama.cpp's `-hf` remote-download path. Umbratic
fetches weights itself from revision-pinned URLs it checksums against
`apps/desktop/src/main/modelCatalog.ts`. Models the user adds by Hugging Face
reference (`apps/desktop/src/main/customModels.ts`) follow the same rule with
the pin moved to add time: resolving the reference records the repository's
current commit and the size and SHA-256 the Hugging Face API publishes for
every offered file, and each later download verifies against that record. The
trust decision for a custom model is the user's, made once, when it is added.

## Choosing a backend on the user's machine, not on ours

One build per platform serves every machine on it. `-DGGML_BACKEND_DL=ON` and
`-DGGML_CPU_ALL_VARIANTS=ON` compile each ggml backend as its own library, which
ggml enumerates beside the executable at process start: it loads the CPU variant
matching the instruction set actually present, adds the GPU backend when the
platform provides one, and skips any backend it cannot load.

That last part is the reason for it. Linked statically against Vulkan, the
executable carries a load-time dependency on `vulkan-1.dll` and fails to start
at all on a machine with no Vulkan-capable display driver — a bare VM, a remote
session on the basic display adapter — instead of falling back to the CPU. As a
loadable backend it is simply absent there.

`-DGGML_NATIVE=OFF` is not optional, and ggml refuses it alongside
`GGML_BACKEND_DL` anyway. Left at its default it compiles `-march=native`
against the build machine's own CPU, and a release built that way crashes with
an illegal instruction on any older user CPU, at first launch. macOS builds also
pin `CMAKE_OSX_DEPLOYMENT_TARGET` to Electron's own minimum so the sidecar
cannot refuse to load on a macOS the app supports.

Per platform:

| Platform | GPU backend | CPU |
| --- | --- | --- |
| macOS (Apple Silicon) | Metal, shader library embedded | ARM variants |
| Windows x64 | Vulkan, via the display driver's loader | x86 variants |
| Windows arm64 | none — the Adreno Vulkan path is not dependable enough to ship | ARM variants |

`verify:package` asserts the packaged directory holds the executable at the
pinned build number, at least one CPU backend, and the GPU backend that platform
expects — so a backend that silently stops being built cannot ship as a
quietly CPU-only release.

Windows packaging needs the Vulkan SDK on the build machine for headers and
`glslc` (`winget install KhronosGroup.VulkanSDK`, then a new terminal so
`VULKAN_SDK` is set). Installing it in CI is an unreviewed binary download and
is governed by the rules above; it is not yet wired into `package-desktop.yml`.

`UMBRATIC_LLAMA_CPU_ONLY=1` packages without a GPU backend, for iterating on
packaging without the SDK. The resulting app runs on any machine and is far too
slow to ship, so `verify:package` refuses a build with no GPU backend unless the
same variable is set there too. CI never sets it, which is what keeps a release
that quietly lost its GPU backend from passing.

Bumping the pin is a supply-chain review: read the intervening release notes,
update both `tag` and `commit`, and rerun packaging and `verify:package` on both
platforms.

## Dependency updates

Routine version updates come from Dependabot and wait 14 days after publication.
Security updates are not subject to that cooldown. Do not manually edit version
numbers or lockfile resolutions in feature work.

Two npm behaviours will waste an afternoon if you meet them cold. `npm install`
reconciles against the `node_modules` already on disk, so a newly added or
changed entry in `overrides` is silently ignored — the lockfile keeps the old
version and nothing warns. Remove `node_modules` and reinstall to apply one.
Separately, `min-release-age` filters versions during resolution and falls back
to the newest allowed one without a message, so a security fix published inside
the cooldown looks like an override that did not take. Resolve those with
`--min-release-age=0`, which is what "security updates are not subject to that
cooldown" means in practice, and commit the resulting lockfile.

A dependency pull request must stay focused and must include:

- The manifest, generated lockfile, and any required
  `supply-chain-policy.json` allowlist change.
- `npm run supply-chain:check` and `npm run test:all` results.
- `npm run supply-chain:audit` results when the audit tools and registry network
  are available.
- An explicit review of new or changed native packages, lifecycle scripts,
  Cargo build scripts, and procedural macros.

New dependencies require a concrete standard-library or existing-dependency
comparison. Reimplementing parsers, cryptography, authentication, policy
matching, or filesystem traversal merely to reduce a package count is not an
acceptable tradeoff.

## Gates and inventories

`npm run supply-chain:check` enforces exact npm specifications, locked registry
sources and checksums, approved licenses, exact native/lifecycle/build-script
allowlists, pinned toolchains, explicit GitHub runner images, and full-SHA
GitHub Action references.

`npm run supply-chain:audit` runs npm vulnerability and registry-signature
checks, RustSec, and `govulncheck`. CI installs exact audited versions of the two
external scanners before invoking it.

`npm run supply-chain:sbom` creates a CycloneDX 1.6 inventory from
`package-lock.json` and locked Cargo metadata without adding an SBOM library to
the application. Tagged releases publish that SBOM and a SHA-256 manifest next
to the installers.

PKCS#12/PFX client identities are intentionally unsupported. Managed endpoints
must use PEM `certPath` and `keyPath`, keeping the default runner on one rustls
TLS stack.

Release signing, notarization, branch protection, repository rulesets,
CODEOWNERS assignment, and GitHub private-repository dependency review require
repository or organization administration and are not configured here.
