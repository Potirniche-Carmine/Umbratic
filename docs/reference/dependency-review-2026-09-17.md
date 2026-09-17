# Dependency reconciliation — 2026-09-17

Reviewed all three open Dependabot PRs against `main` at `27f7d1d` and
combined their changes with the additional fixes found by current dependency
scanners. These are dependency-only changes; no application behavior or test
gate is changed.

## Dependabot updates

| PR | Dependency | Update | Review |
| --- | --- | --- | --- |
| [#91](https://github.com/UmbraticAI/Umbratic/pull/91) | uuid | 1.24.0 → 1.26.0 | Adds serialization and UUIDv7 precision features. Existing UUIDv4 usage needs no adaptation. |
| [#92](https://github.com/UmbraticAI/Umbratic/pull/92) | rust_xlsxwriter | 0.98.1 → 0.99.0 | Includes truncated PNG/JPEG panic and BMP height overflow fixes. Renames `TableNameReused` to `NameReused`; the application does not match that variant. Existing workbook tests exercise defined names and round trips. |
| [#93](https://github.com/UmbraticAI/Umbratic/pull/93) | tree-sitter | 0.26.11 → 0.26.13 | Parser recovery and query correctness fixes. The C build script is byte-for-byte unchanged. |

These PRs are version updates, not evidence that all dependency security
findings have already been covered. GitHub's alerts API reported that
Dependabot security alerts are disabled for this repository.

## Additional audit fixes

| Dependency | Update | Finding |
| --- | --- | --- |
| fast-uri | 3.1.5 → 3.1.6 | Four high-severity host confusion / SSRF advisories: GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp. |
| js-yaml | 4.3.1 → 4.3.2 | [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh): CPU denial of service through empty merge sources. |
| @xmldom/xmldom (plist dependency) | 0.8.14 → 0.8.15 | Eight advisories affecting XML validation, injection, and resource consumption. The application's direct 0.9.12 copy was already patched and remains unchanged. |
| rustls | 0.23.43 → 0.23.45 | [RUSTSEC-2026-0285](https://rustsec.org/advisories/RUSTSEC-2026-0285): TLS 1.3 handshake encryption-level validation. The runner manifest now requires the fixed minimum. |
| rustls-webpki | 0.103.13 → 0.103.15 | Updated with rustls by Cargo's dependency resolver. |
| chacha20 | 0.10.1 → 0.10.2 | Removes the yanked release flagged by `cargo audit --deny warnings`. |
| golang.org/x/crypto | 0.54.0 → 0.56.0 | Removes GO-2026-6303, GO-2026-6354, GO-2026-6355. These SSH advisories were module-only findings, not reachable in Console. |

## Supply-chain review

- No npm packages or Cargo dependency edges were added or removed. Go changes
  only `golang.org/x/crypto`; `go mod verify` passes.
- The three changed npm packages have no lifecycle scripts or platform/native
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

- `npm run supply-chain:check`: passed.
- `npm run supply-chain:audit`: passed, with the module-only caveat above.
- `npm audit --audit-level=low`: passed, zero vulnerabilities.
- Console `go mod verify`, `go vet ./...`, and `go test -race ./...`: passed.
- `npm run test:all`: stopped at the pre-existing source-size gate:
  `apps/desktop/src/renderer/main.tsx` has 4,895 lines against a 4,873 baseline.
  The file is unchanged and has the same 4,895 lines in the base commit.
  Cargo formatting, Clippy, Go vet, and both Go race suites passed before
  that gate. All remaining test/build steps were run separately.
- PDF, code-index, artifacts, and runner unit/integration suites: passed.
- Desktop release compilation, TypeScript checks, native tests, and production
  build: passed. The first desktop unit run failed at two test-file loads
  (`main-capabilities` and `main-local-veil`); both passed individually, and
  the complete unchanged unit-suite rerun passed all 565 tests. The initial
  failure was not reproduced, so its cause remains unconfirmed.
- Veil and Console regular Go test suites: passed.
