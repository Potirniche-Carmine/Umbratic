# Supply chain

Dependency changes are security changes. npm, Cargo, Go and the managed-server
wheels use reviewed locked graphs; native sources and executable downloads have
explicit pins and provenance. Veil stays on the Go standard library. Local
source backports and wheel changes are recorded below and in the
[runtime advisory review](runtime-security.md).

## Set up a machine

Use the exact versions in `.nvmrc`, `rust-toolchain.toml`, and
`infrastructure/veil/go.mod`.

```bash
npm ci --ignore-scripts --omit=peer
```

```bash
cargo fetch --locked
```

```bash
npm run dependencies:provision
```

The third command is separate on purpose: it runs the install program from the
integrity-checked Electron package and verifies Electron's published checksum
before making the runtime available. Development and packaging fail if the
runtime was not provisioned.

The Windows package uses NSIS. `--omit=peer` leaves out its unused Squirrel
backend; the supply-chain gate verifies the exact reviewed omission and
NSIS-only packaging configuration.

All Cargo builds must pass `--locked`.

## The gates

```bash
npm run supply-chain:check
```

Enforces exact npm specifications, locked registry sources and checksums,
approved licences, exact native/lifecycle/build-script allowlists, pinned
toolchains, explicit GitHub runner images, full-SHA Action references.

```bash
npm run supply-chain:audit
```

npm vulnerability and registry-signature checks, RustSec, `govulncheck` for
Veil, Console and the Caddy source graph, plus OSV queries for the exact server
wheel versions and actually compiled Go modules. Unreviewed runtime matches fail.
Source-patched JOSE matches require the pinned complete source manifest and actual
module replacement. The scoped setuptools findings require the exact reviewed
Mac/offline-wheel controls, including hashes of their executable implementation;
changed controls invalidate that applicability decision. Incomplete, erroneous or
paginated OSV responses fail; changed advisory modification timestamps require
review. All raw matches and verified dispositions remain visible in the audit log
and generated report.
Install the exact audited versions of cargo-audit and govulncheck from
`supply-chain-policy.json` first.

```bash
npm run supply-chain:sbom
```

CycloneDX 1.6 source inventory includes npm, locked Cargo metadata, host-compiled
Go modules, server wheels and pinned native sources. It generates offline after
the locked sources/toolchain are provisioned. Caddy's effective binary/module
inventory and natively modified wheel hashes also appear in the sealed server
kit; generated binaries are not mislabeled with their upstream archive hashes.

## Unreachable OpenPGP advisory

`govulncheck` reports [GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932) at module
scope for the deprecated `golang.org/x/crypto/openpgp` packages. They have no
published fix. Console uses `golang.org/x/crypto` for Argon2id password hashing;
its compiled dependencies include `argon2` and `blake2b`, and no OpenPGP package.
The reviewed Caddy graph also uses crypto helpers without importing OpenPGP.
The scanner reports zero affected imported packages or called symbols for this
advisory. `supply-chain-policy.json` records the reviewed exception, and the audit
continues to display it; it is not suppressed.

## Adding or updating a dependency

1. Routine version updates come from Dependabot and wait **14 days** after
   publication. Security updates are exempt.
2. Do not hand-edit version numbers or lockfile resolutions in feature work.
3. A dependency PR must include the manifest, the generated lockfile, any
   `supply-chain-policy.json` allowlist change, `supply-chain:check` and
   `test:all` results, `supply-chain:audit` results when the tools and network
   are available, and an explicit review of new or changed native packages,
   lifecycle scripts, Cargo build scripts, and procedural macros.
4. A new dependency needs a concrete standard-library or existing-dependency
   comparison. Reimplementing parsers, cryptography, authentication, policy
   matching, or filesystem traversal just to reduce a package count is not an
   acceptable trade.

### Two npm behaviours that waste an afternoon

`npm install` reconciles against the `node_modules` already on disk, so a new
or changed `overrides` entry is **silently ignored** — the lockfile keeps the
old version and nothing warns. Remove `node_modules` and reinstall.

`min-release-age` filters versions during resolution and **falls back to the
newest allowed one without a message**, so a security fix published inside the
cooldown looks like an override that did not take. Use `--min-release-age=0` —
that is what "security updates are exempt" means in practice — and commit the
resulting lockfile.

## The bundled llama.cpp runtime

Local mode runs `llama-server`, built from source during desktop packaging at
the commit in `third_party/llama.cpp.pin`. No prebuilt archive is downloaded.
Packaging refuses to continue when the cloned tag does not resolve to the
pinned SHA, and `verify:package` asserts the packaged executable reports the
pinned commit. The pin selects an upstream stable release; the current native
advisory review is recorded in [Runtime security](runtime-security.md).

Build machines also need CMake 3.21+, and per platform:

| Platform | Needs | GPU backend | CPU |
| --- | --- | --- | --- |
| macOS (Apple Silicon) | Xcode Command Line Tools, `brew install cmake` | Metal, shader library embedded | ARM variants |
| Windows x64 | MSVC Build Tools 2022, Vulkan SDK (`VULKAN_SDK` set), Ninja | Vulkan, via the display driver's loader | x86 variants |
| Windows arm64 | Visual Studio ARM64 toolset and Clang, Ninja | none — the Adreno Vulkan path is not dependable enough to ship | portable ARMv8 NEON backend; OpenMP disabled |

Windows needs Ninja because the default MSBuild generator trips MAX_PATH in the
nested shader build. `UMBRATIC_LLAMA_GENERATOR` overrides the generator.

Bumping the pin is a supply-chain review: read the intervening release notes,
update both `tag` and `commit`, rerun packaging and `verify:package` on both
platforms.

### Why the build flags are what they are

`-DGGML_BACKEND_DL=ON` and `-DGGML_CPU_ALL_VARIANTS=ON` compile each ggml
backend as its own library, enumerated beside the executable at process start:
it loads the CPU variant matching the instruction set actually present, adds
the GPU backend when the platform provides one, and skips any it cannot load.

That last part is the reason. Linked statically against Vulkan, the executable
carries a load-time dependency on `vulkan-1.dll` and **fails to start at all**
on a machine with no Vulkan-capable display driver — a bare VM, a remote
session on the basic display adapter — instead of falling back to the CPU. As a
loadable backend it is simply absent there.

`-DGGML_NATIVE=OFF` is not optional. Left at its default it compiles
`-march=native` against the build machine's CPU, and a release built that way
crashes with an illegal instruction on any older user CPU, at first launch.
Native macOS sidecars target macOS 12; the Electron desktop app requires macOS 13 or later.

The reviewed `llama.cpp-disable-remote-downloads.patch` rejects the shared
outgoing HTTP client before URL parsing, DNS or socket creation. This covers
model, Hugging Face, Docker and HTTP(S) image/audio downloads. Package verification
executes HTTP and HTTPS download attempts without `--offline`, requires the
compiled rejection, and checks that a live listener received no connection.
The app also passes `--offline` for chat and speech. TLS, RPC, router subprocesses,
the embedded Web UI and optional tunnel/helper downloads are disabled at build
time. The loopback inference server remains available. Umbratic
fetches weights itself from revision-pinned URLs it checksums against
`apps/desktop/src/main/modelCatalog.ts`. Models a user adds by Hugging Face
reference follow the same rule with the pin moved to add time: resolving the
reference records the repository's current commit and the size and SHA-256 the
Hugging Face API publishes for every offered file, and each later download
verifies against that record. The trust decision for a custom model is the
user's, made once, when it is added.

`UMBRATIC_LLAMA_CPU_ONLY=1` packages without a GPU backend, for iterating on
packaging without the SDK. The result is far too slow to ship, so
`verify:package` refuses a build with no GPU backend unless the same variable
is set there too. A release build never sets it — which is what stops a release
that quietly lost its GPU backend from passing.

## Reviewed spreadsheet patch

`third_party/umya-spreadsheet` contains the production source of crates.io
`umya-spreadsheet 4.0.0-beta.1`, under its MIT license. Stable 3.0.1 still requires
zip 8, affected by RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369.
Version 4 is the only published fixed dependency path. Its validation writer has
a regression: it treats empty formulas as inner content. The one-line local
correction tests for nonempty formulas, preserving validation bounds when cells
are edited. Artifact round-trip tests cover this behavior. The prerelease remains
a dependency risk to reassess at the next stable release.

`PROVENANCE.json` records the upstream archive SHA-256 and exact changes; production
source, license and manifest are retained, while upstream examples, tests and images
are omitted. `SHA256SUMS.json` pins every included file, and its digest is reviewed
in `supply-chain-policy.json`. The supply-chain gate rejects changed or added files.
No security advisory is suppressed.

The October 2026 refresh updates Electron, Vite, matching and HTTP dependencies,
Rust TLS/certificate roots, Tokio and archive consumers. ZIP codecs beyond deflate
are disabled, removing the unused vulnerable zstd chain. Go modules require 1.26.10
for standard-library security fixes. The build runtime is pinned to Node 26.12.1
and its bundled npm 11.20.0 for the [October 21 Node security fixes](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
Electron 44.10.0 embeds the fixed Node 24.22.1 runtime; an npm-only audit does not
cover the embedded runtime, so its [official release notes](https://releases.electronjs.org/release/v44.10.0) are reviewed too. Native and procedural-code allowlists track the
reviewed graph; the Brotli decompressor's `BSD-3-Clause/MIT` license expression is
reviewed alongside the already allowed individual licenses.

## Releases

Desktop releases publish to public GitHub Releases. Build workflows pin their
Actions, and the Windows Vulkan SDK installer is pinned by SHA-256 in
`third_party/vulkan-sdk.json` and verified before execution. Windows signing tools
and the isolated x64 .NET runtime are pinned by official package/archive checksums
in `third_party/windows-signing.json`; no moving PowerShell module is installed.
Signing credentials
stay in GitHub Actions secrets. The updater sends ordinary GitHub release
requests and can be disabled in Settings → About. It does not need a company token.

Runbook: [../guides/release-desktop.md](../guides/release-desktop.md).

Windows packaging inspects normal and delay-load PE imports with the installed
MSVC `dumpbin`. Only the explicit Windows OS/API-set contract list remains
external. Required CRT/OpenMP DLLs come from the matching `VCToolsRedistDir`;
their architecture and Microsoft Authenticode chain are verified before copying
them beside the executable or native module. Original Microsoft signatures,
public version/certificate/hash provenance and Visual Studio notices are retained.
Package verification checks the resulting dependency closure. The sole non-OS
exception is `ggml-vulkan.dll`'s optional `vulkan-1.dll` driver loader: the CPU
backend remains available when that driver backend cannot load. This adds no
downloads and changes no compiler optimizations or selected backends.

## Not supported, deliberately

PKCS#12/PFX client identities. Managed endpoints must use PEM `certPath` and
`keyPath`, keeping the default runner on one rustls TLS stack.

Release workflows define signed builds and notarization. The public repository
requires pull requests and the `CI required` and `CodeQL` checks for `main`, and
disables force pushes and branch deletion. Administrators configure signing
credentials and reviewer/CODEOWNERS rules through GitHub. Keep credentials out
of source control; follow the [release guide](../guides/release-desktop.md).

## Image runtime sources

Every supported image CLI is built from the same official stable-diffusion.cpp source and exact ggml submodule revision, with archive sizes and SHA-256 hashes pinned in `third_party/stable-diffusion.cpp.json`. This replaces the former Windows/Linux binaries, whose embedded ggml lacked later GGUF overflow checks. The macOS build targets macOS 12, links its libraries statically, and embeds Metal; its only dynamic dependencies are system frameworks and libraries. Windows x64 and Linux x64 retain their CPU backend. Packaging verifies the actual architecture, platform libraries and reported revision.

The build uses bundled tokenizer/image helpers, disables CMake dependency downloads, and builds only the CLI. The app uses PNG output; optional WebP/WebM codecs and the upstream server frontend are excluded. Cached sources and build outputs live under `apps/desktop/.llama-cache/image-runtime/`. Delete that directory to rebuild. Model weights retain their own licenses.
