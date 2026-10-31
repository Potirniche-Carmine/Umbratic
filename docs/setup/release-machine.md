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

On Windows, configure the four `UMBRATIC_WIN_SIGN_*` identifiers and Azure
service-principal credentials. The publisher must exactly match the certificate
subject common name. The release pipeline uses reviewed pinned Microsoft
signing tooling and verifies all shipped native executable signatures.

Run `npm run desktop:release` to build and verify locally. It never uploads.
An unsigned build always requires the explicit `--unsigned` flag.
