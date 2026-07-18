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

## Dependency updates

Routine version updates come from Dependabot and wait 14 days after publication.
Security updates are not subject to that cooldown. Do not manually edit version
numbers or lockfile resolutions in feature work.

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
