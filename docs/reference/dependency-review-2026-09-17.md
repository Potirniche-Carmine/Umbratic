# Dependency reconciliation — updated 2026-09-18

Reconciled the three Dependabot PRs and additional scanner findings against
`release/v0.0.2` at `48611f7`. The initial review used `main`; PR #95 targets
the release branch, and its conflicts are resolved. Release version 0.0.2,
release tooling, and existing futures 0.3.34 updates are preserved. These are
dependency-only changes; no application behavior or test gate is changed.

## Dependabot updates

| PR | Dependency | Update | Review |
| --- | --- | --- | --- |
| [#91](https://github.com/UmbraticAI/Umbratic/pull/91) | uuid | 1.25.0 → 1.26.0 | Adds serialization and UUIDv7 precision features. Existing UUIDv4 usage needs no adaptation. |
| [#92](https://github.com/UmbraticAI/Umbratic/pull/92) | rust_xlsxwriter | 0.98.2 → 0.99.0 | The release already includes the truncated PNG/JPEG panic and BMP height overflow fixes from 0.98.2. Renames `TableNameReused` to `NameReused`; the application does not match that variant. Existing workbook tests exercise defined names and round trips. |
| [#93](https://github.com/UmbraticAI/Umbratic/pull/93) | tree-sitter | 0.26.11 → 0.26.13 | Parser recovery and query correctness fixes. The C build script is byte-for-byte unchanged. |

These PRs are version updates, not evidence that all dependency security
findings have already been covered. GitHub's alerts API reported that
Dependabot security alerts are disabled for this repository.

## Additional audit fixes

| Dependency | Update | Finding |
| --- | --- | --- |
| fast-uri | 3.1.6 retained from release | Four high-severity host confusion / SSRF advisories: GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp. |
| js-yaml | 4.3.1 → 4.3.2 | [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh): CPU denial of service through empty merge sources. |
| @xmldom/xmldom (plist dependency) | 0.8.15 retained from release | Eight advisories affecting XML validation, injection, and resource consumption. The application's direct 0.9.12 copy was already patched and remains unchanged. |
| rustls | 0.23.43 → 0.23.45 | [RUSTSEC-2026-0285](https://rustsec.org/advisories/RUSTSEC-2026-0285): TLS 1.3 handshake encryption-level validation. The runner manifest now requires the fixed minimum. |
| rustls-webpki | 0.103.13 → 0.103.15 | Updated with rustls by Cargo's dependency resolver. |
| chacha20 | 0.10.1 → 0.10.2 | Removes the yanked release flagged by `cargo audit --deny warnings`. |
| golang.org/x/crypto | 0.54.0 → 0.56.0 | Removes GO-2026-6303, GO-2026-6354, GO-2026-6355. These SSH advisories were module-only findings, not reachable in Console. |

## Supply-chain review

- No npm packages or Cargo dependency edges were added or removed. Go changes
  only `golang.org/x/crypto`; `go mod verify` passes.
- The changed js-yaml package has no lifecycle scripts or platform/native
  constraints. Existing native and lifecycle allowlists remain unchanged.
- Of the six changed Rust crates, only tree-sitter and rustls have build
  scripts. Both scripts are unchanged from their previous versions; their
  exact versions were updated in the reviewed allowlist. No changed crate
  introduces a procedural macro.
- Licenses remain within the existing policy. Registry checksums are retained;
  no Git dependencies, new sources, or audit suppressions were introduced.
- The fast-uri and js-yaml exact overrides match the policy. Installs retained
  the 14-day npm release-age guard and disabled lifecycle scripts.
- npm registry verification passed for 314 signatures and 61 attestations.

## Security result and limits

`npm audit --audit-level=low` reports zero vulnerabilities, including development
dependencies. `npm run supply-chain:audit` passes npm lockfile and signature
audits, RustSec with warnings denied, and both Go vulnerability scans.

Console retains one already-reviewed module-only advisory:
[GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932), the permanent deprecation
of `golang.org/x/crypto/openpgp`, with no patched release. Console imports
Argon2, not OpenPGP; govulncheck reports zero vulnerable imported packages and
zero vulnerable called symbols. The existing policy exception is unchanged.
A clean dependency scan is not a guarantee that no unknown vulnerabilities
exist or an audit of the separately vendored model runtime.

## Validation

Security audit rerun against the reconciled release branch:

- `npm run supply-chain:check`: passed.
- `npm run supply-chain:audit`: passed, with the module-only caveat above.
- npm install/audit reports zero vulnerabilities; 314 signatures and 61
  attestations verified.

- Cargo formatting, workspace Clippy, and Go vet for both services passed.
- The production Rust workspace compiled successfully with `--locked --release`.
  Main-process TypeScript compilation also passed when invoked directly.
  The Vite build stalled and was stopped; the full desktop build is incomplete.
- `npm run test:all` was attempted on the reconciled release branch. Go race
  test executables stalled before their entry points. Separately running the
  remaining suite passed the 16 PDF library tests but stalled at PDF CLI
  process startup. macOS `sample` showed both `veil.test` and `umbratic-pdf`
  stopped in `_dyld_start`, with no application frames. The stalled process
  trees were terminated; the release test rerun is incomplete.
- The unchanged release source-size gate also fails: renderer/main.tsx has
  5,040 lines against its 4,873-line baseline, identical to the release base.
- Earlier tests on the main-based dependency branch passed after the documented
  desktop rerun, but those results do not establish a passing release suite.
