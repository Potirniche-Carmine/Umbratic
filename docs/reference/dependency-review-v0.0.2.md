# Dependabot review for release/v0.0.2

Reviewed 2026-09-07 against release commit `5a4cebd`. The five original
Dependabot PRs target `main`; this review applies only the selected dependency
diffs to `release/v0.0.2`.

## Decisions

| Dependency | Proposed update | Decision | Reason |
| --- | --- | --- | --- |
| futures-util | 0.3.33 → 0.3.34 | Include | Fixes cloned task-waker identity. Relevant to the runner's asynchronous streams and concurrent tool execution. |
| rust_xlsxwriter | 0.98.1 → 0.98.2 | Include | Rejects invalid defined names instead of producing invalid workbooks or panicking; also hardens image dimension parsing. Umbratic calls `Workbook::define_name`. |
| uuid | 1.24.0 → 1.25.0 | Include | Small maintenance update including the intervening non-ASCII parse-diagnostic fix. Random v4 generation is unchanged; the new optional serde byte-string API is not enabled. |
| umya-spreadsheet | 3.0.1 → 3.1.0 | Exclude | Reproduced loss of both bounds of a between-style data-validation rule when editing an unrelated cell. Keep 3.0.1 until an upstream fix is reviewed. |
| http-body-util | 0.1.4 → 0.1.5 | Defer | Only changes documentation rendering from `doc_auto_cfg` to `doc_cfg`; no runtime benefit for this release. |

Upstream source comparisons and original PRs:

- futures-util: [source diff](https://github.com/rust-lang/futures-rs/compare/0.3.33...0.3.34), [#84](https://github.com/UmbraticAI/Umbratic/pull/84).
- rust_xlsxwriter: [source diff](https://github.com/jmcnamara/rust_xlsxwriter/compare/v0.98.1...v0.98.2), [#89](https://github.com/UmbraticAI/Umbratic/pull/89).
- uuid: [source diff](https://github.com/uuid-rs/uuid/compare/v1.24.0...1.25.0), [#88](https://github.com/UmbraticAI/Umbratic/pull/88).
- umya-spreadsheet: [source diff](https://github.com/MathNya/umya-spreadsheet/compare/3.0.1...3.1.0), [#87](https://github.com/UmbraticAI/Umbratic/pull/87).
- http-body-util: [source diff](https://github.com/hyperium/http-body/compare/http-body-util-v0.1.4...http-body-util-v0.1.5), [#86](https://github.com/UmbraticAI/Umbratic/pull/86).

## Why umya-spreadsheet 3.1.0 is excluded

The release has useful fixes for pivot-cache preservation, styles, whole-row
and whole-column formula references, and XML character references. Its scope
is considerably broader than the other updates: the upstream comparison
changes 55 files and announces breaking pivot-table changes.

More importantly, the published crate's `src/structs/data_validation.rs`
changes the writer's condition to:

```rust
let is_inner = self.formula1.text().is_empty() || self.formula2.text().is_empty();
```

When both formulas contain bounds, this is false and the writer emits a
self-closing `dataValidation` element with neither formula. The regression
test creates an XLSX with whole-number validation between 1 and 10 on A1:A10,
then runs Umbratic's `setCells` operation on B1. It checks the original and
output worksheet XML for both bounds and verifies the requested cell edit.
It fails with 3.1.0 and passes with 3.0.1. This exercises the product's edit
path, rather than only the dependency's reader.

The test remains in `packages/artifacts/tests/dependency_round_trip.rs` to
protect the next upgrade. A second test checks that invalid defined names
return errors without panicking under rust_xlsxwriter 0.98.2.

## Supply-chain and compatibility review

Publication dates, yanked status, minimum Rust versions, licenses, and
checksums were checked against the crates.io version API. All five proposed
versions were unyanked and older than the required 14 days at review time.

| Proposed crate | Published (UTC) | Minimum Rust |
| --- | --- | --- |
| futures-util 0.3.34 | 2026-08-11 | 1.71 |
| http-body-util 0.1.5 | 2026-08-12 | 1.61 |
| rust_xlsxwriter 0.98.2 | 2026-08-17 | 1.88.0 |
| umya-spreadsheet 3.1.0 | 2026-08-17 | 1.88.0 |
| uuid 1.25.0 | 2026-08-22 | 1.85.0 |

All fit the pinned Rust 1.96.0 toolchain. The selected changes retain the
existing licenses and enabled features. The generated Dependabot lockfile
diffs were applied without a broad dependency refresh; `cargo metadata
--locked` validated the resulting graph.

The final graph updates eight package versions: futures-core, futures-io,
futures-macro, futures-sink, futures-task, and futures-util to 0.3.34,
rust_xlsxwriter to 0.98.2, and uuid to 1.25.0. No package names are added or
removed. futures-channel remains at its existing version.

The only procedural-macro change is futures-macro 0.3.33 → 0.3.34. Its Rust
source files are unchanged; its manifest switches from syn 2 to syn 3.
The lockfile already contains syn 3.0.3, so this adds no parser package or
version. The exact allowlist entry is replaced in supply-chain-policy.json.
All-target metadata includes this macro through the WebAssembly dependency
graph, even though the native macOS build does not compile it.

No new or changed Cargo build scripts, native packages, npm lifecycle
scripts, npm packages, Git dependencies, or executable downloads are
introduced. rust_xlsxwriter retains `default-features = false`; uuid retains
its existing v4 configuration. No application API migration is required.

## Validation

- `cargo test --locked --package umbratic-artifacts --all-targets`: passed
  (30 unit tests and two dependency regression tests).
- The validation-bounds regression test failed with umya-spreadsheet 3.1.0
  and passed after restoring 3.0.1.
- `npm run supply-chain:check`: passed.
- `npm run test:all`: stopped at the source-size gate after Cargo formatting,
  workspace Clippy, Go vet, and both Go race suites passed. The two failures
  are already present in the original release commit: renderer/main.tsx is
  5,040 lines against a 4,873-line allowance, and shared/desktopApiTypes.ts is
  1,027 lines against the 1,000-line limit. Both files are byte-for-byte
  unchanged. The gate was not modified.
- The remaining workspace tests and desktop build passed when run separately:
  PDF and code-index `test:all`, artifact all-target tests, runner `test:all`
  (246 unit tests, 10 Rust integration tests, and 22 real-process tests),
  desktop `test:all` (six native tests and 577 TypeScript tests), both Go test
  suites, and the desktop production build including the release Cargo
  workspace build.
- `npm audit signatures --min-release-age=0`: passed; 332 registry
  signatures and 63 attestations verified.
- `npm run supply-chain:audit`: stopped at existing npm vulnerabilities:
  @xmldom/xmldom (moderate, GHSA-6gmq-8vp8-gcm6) and fast-uri (high;
  GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf,
  GHSA-jqff-g426-hqxp). The npm manifests and lockfile are unchanged.
- Separately, `cargo audit --deny warnings` found no vulnerability advisory
  but failed on yanked chacha20 0.10.1. Auditing the original release lockfile
  produced the same result. It comes through unchanged rand 0.10.2 under
  lopdf and umya-spreadsheet; none of the selected bumps changes that path.
- `govulncheck` was unavailable on PATH. Go vulnerability scanning was not
  completed; no Go dependency or code changes are included.

The audit failures remain visible; no security gate or exception was relaxed.
They need separate dependency remediation. The original Dependabot PRs are
left open because they target `main`.
