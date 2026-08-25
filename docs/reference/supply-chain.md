# Supply chain

Dependency changes are security changes. Only locked crates.io and npm
packages; Veil stays on the Go standard library; executable downloads are
explicit.

## Set up a machine

Use the exact versions in `.nvmrc`, `rust-toolchain.toml`, and
`infrastructure/veil/go.mod`.

```bash
npm ci --ignore-scripts
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

npm vulnerability and registry-signature checks, RustSec, `govulncheck`.
Install the exact audited versions of cargo-audit and govulncheck from
`supply-chain-policy.json` first.

```bash
npm run supply-chain:sbom
```

CycloneDX 1.6 inventory from `package-lock.json` and locked Cargo metadata.

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
pinned build number.

Build machines also need CMake 3.21+, and per platform:

| Platform | Needs | GPU backend | CPU |
| --- | --- | --- | --- |
| macOS (Apple Silicon) | Xcode Command Line Tools, `brew install cmake` | Metal, shader library embedded | ARM variants |
| Windows x64 | MSVC Build Tools 2022, Vulkan SDK (`VULKAN_SDK` set), Ninja | Vulkan, via the display driver's loader | x86 variants |
| Windows arm64 | same | none — the Adreno Vulkan path is not dependable enough to ship | ARM variants |

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
macOS builds also pin `CMAKE_OSX_DEPLOYMENT_TARGET` to Electron's own minimum.

`-DLLAMA_CURL=OFF` removes llama.cpp's `-hf` remote-download path. Umbratic
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

## Releases

Built and signed on our own machines, published to `downloads.umbratic.ai` by
`scripts/publish-release.ts`, which talks S3's API directly with a SigV4
signature rather than through an SDK.

The installed app updates through electron-updater: macOS refuses an app not
signed by the same Team ID, Windows verifies the installer's publisher. Neither
the app nor the script trusts the transport for anything else. Published
installers are immutable, the channel file never moves to an older release, and
an unsigned build is refused at publish time.

An update check sends a `User-Agent` naming the build and the company's update
token, and nothing that distinguishes one machine from another. It can be
turned off in Settings → About. An installation with no current token does not
check at all.

Runbook: [../guides/release-desktop.md](../guides/release-desktop.md).

## Not supported, deliberately

PKCS#12/PFX client identities. Managed endpoints must use PEM `certPath` and
`keyPath`, keeping the default runner on one rustls TLS stack.

Release signing, notarization, branch protection, repository rulesets,
CODEOWNERS assignment, and GitHub private-repository dependency review require
repository or organization administration and are not configured here.
