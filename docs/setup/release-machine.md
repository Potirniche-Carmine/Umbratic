# Local release packaging

GitHub Actions owns public releases. See the
[desktop release guide](../guides/release-desktop.md) for repository signing
secrets and the automated pipeline. A local machine is useful for inspecting
packages and troubleshooting.

Install the toolchains pinned by `.nvmrc`, `rust-toolchain.toml`, and
`infrastructure/veil/go.mod`, plus CMake 3.21+. macOS needs Xcode command-line
tools. Windows needs MSVC Build Tools and Ninja. Windows x64 also needs the
reviewed Vulkan SDK pinned in `third_party/vulkan-sdk.json`; the checksum-
verifying installer is `scripts/ci/install-vulkan.ps1` on a GitHub runner.

Install dependencies and provision Electron explicitly:

```sh
npm ci --ignore-scripts --omit=peer
npm run dependencies:provision
npm run desktop:release -- --unsigned --dir
```

For a CPU-only local Windows packaging test, set
`UMBRATIC_LLAMA_CPU_ONLY=1` for packaging and verification. Signed releases
reject that setting.

## Signing locally

Copy `docs/release.env.example` to `artifacts/release-work/release.env` on
macOS, or `~/.umbratic/release.env` on Windows/Linux. Restrict that file to your
own account. Environment values override the file.

On macOS, import a **Developer ID Application** certificate with its private
key into your keychain. Supply either the complete Apple ID notarization
triple or the complete App Store Connect API key triple from the example.
A signed build requires notarization credentials and an available signing
identity. Keep the app ID and Developer team stable across releases.

Windows distribution signing runs only through the approved SignPath GitHub
workflow. Configure its account, manual approvals, Actions variables and API
secret using the [release guide](../guides/release-desktop.md); do not store the
SignPath token in this local file. Upstream executable signatures and provenance
remain distinct from project signatures.

On macOS, `npm run desktop:release` builds and verifies a local signed package;
it never publishes a GitHub release. Local Windows inspection uses the explicit
`--unsigned` flag. Public releases never fall back to unsigned output.
