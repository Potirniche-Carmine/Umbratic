# Rust rewrite: measured performance and security analysis

## Scope and architecture

The local runner is now a native Rust executable. Its authenticated loopback HTTP/SSE contract, Veil request formats, tools, permissions, diagnostics, context compression/retrieval, workspace graph, action enforcement, and shutdown behavior remain behind the same desktop adapter.

The desktop remains Electron/React where Rust is not an applicable replacement without changing the product UI/runtime. Repository file search moved to a bounded Rust desktop-core executable; Electron lifecycle, safe storage, SQLite, preload isolation, React rendering, PDF/Office integrations, and Veil process ownership remain TypeScript. Authored JavaScript/CJS launchers, scripts, and tests were removed or converted to TypeScript. Generated Vite/Electron JavaScript remains a build artifact.

## Method

Measurements were collected on the same Apple arm64 host with Node v26.3.0 on 2026-07-16/17. Runner measurements use the same local fake Veil server, workspace fixture, requests, SSE parsing, sample counts, and benchmark program before and after the rewrite. No model inference or external network latency is included.

The Electron benchmark launches the same Electron runtime against the same trusted local Vite renderer, disables the unchanged Veil child process, records a renderer-loaded marker from application code, waits 500 ms, and sums the four-process Electron tree RSS. The repository-search benchmark calls the real desktop search module on this repository; the TypeScript implementation hit its existing 15-second content-search timeout and returned partial results, while the Rust implementation excludes generated `target` trees and returned the requested result limit. That result is a real user-visible improvement but combines implementation speed with a generated-directory filtering fix.

Raw data is stored beside this report:

- `performance/baseline-typescript.json`
- `performance/final-rust-runner.json`
- `performance/baseline-electron-typescript.json`
- `performance/final-electron-rust.json`
- `performance/baseline-desktop-search-typescript.json`
- `performance/final-rust-desktop-search.json`

## Results

| Workload (median unless noted) | TypeScript | Rust rewrite | Change |
|---|---:|---:|---:|
| Runner cold start, 20 samples | 77.675 ms | 2.922 ms | 96.2% lower; 26.6x faster |
| Authenticated session round trip, 100 samples | 0.186 ms | 0.161 ms | 13.4% lower |
| Streamed chat turn, 20 samples | 0.559 ms | 0.391 ms | 30.1% lower |
| Streamed read-tool turn, 20 samples | 1.062 ms | 0.640 ms | 39.7% lower |
| Runner idle RSS | 64.08 MB | 7.65 MB | 88.1% lower |
| Runner warm RSS | 74.42 MB | 9.93 MB | 86.7% lower |
| Desktop repository search, 30 samples | 15,023.141 ms | 16.107 ms | 99.89% lower; 932.7x faster |
| Electron process-to-renderer load, 10 samples | 1,275.842 ms | 1,300.564 ms | 1.94% slower |
| Electron main-module-to-renderer load, 10 samples | 1,188.621 ms | 1,209.296 ms | 1.74% slower |
| Electron settled tree RSS | 1,488.44 MB | 1,488.86 MB | 0.03% higher |

The runner has a clear performance and memory improvement. Native repository search also has a clear improvement. The full Electron shell does **not** have a demonstrated startup or memory improvement: its median startup was about 2% slower and RSS was effectively unchanged. This is expected because Chromium, React, and the four-process Electron tree dominate those measurements, and the native components are started only when their functions are needed.

The shipped runner changed from 235 KB of JavaScript plus a Node/Electron runtime dependency to a 4.48 MB self-contained native executable. The desktop-core executable is about 400 KB. This increases application resource size by roughly 4.65 MB while removing the runner's runtime dependence on Node.

## Security implications

Improvements:

- Provider JSON/SSE parsing, session state, context storage, workspace graph operations, and tool orchestration now use Rust's memory-safe ownership model.
- The loopback API retains Basic authentication and now compares credentials in constant time, emits no-store/no-cache headers, rejects malformed JSON shapes, and enforces a 512 KiB request limit before deserialization.
- Provider redirects are disabled, remote HTTP endpoints remain prohibited, TLS is limited to TLS 1.2+, and existing PEM mTLS, PKCS#12/PFX identities, custom CA, SNI/server-name override, and SHA-256 certificate pinning remain supported. Pin validation occurs after normal certificate/hostname validation and before response content is consumed.
- Workspace resolution canonicalizes existing ancestors, rejects symlink/junction escapes and blocked secret paths, and handles macOS temporary-directory aliases correctly.
- Desktop search accepts structured arguments only, performs no shell invocation, does not follow symlinks, bounds file sizes and result counts, and excludes generated and credential-bearing directories.
- Shell commands remain permission-gated and statically block network and external-directory access. Unix commands run in a dedicated process group so timeout/abort terminates the command tree; stdout/stderr are bounded and redacted while streaming.
- The Node/CJS runner launcher and production TypeScript runner dependency graph are gone, reducing dynamic module-loading and package-runtime attack surface.

Residual and new risks:

- Electron/Chromium, preload IPC, renderer dependencies, SQLite/safeStorage integration, and the Go Veil service are unchanged; this rewrite does not reduce their attack surface.
- The command tool intentionally invokes a local shell after policy and user permission. Static classification cannot make arbitrary shell text intrinsically safe, so normal permission mode remains an important boundary.
- Native binaries are platform-specific and must be code-signed/notarized with the application. An attacker able to replace installed resources could replace a sidecar binary; release signing and installer integrity are the mitigation.
- Rust introduces a Cargo dependency supply chain, including platform TLS backends. `Cargo.lock`, a pinned Rust 1.96 toolchain in CI, disabled HTTP redirects, and locked npm dependencies reduce drift, but automated `cargo audit`/OSV review should be added to release operations.
- One small `unsafe` block sends `SIGTERM` to a Unix process group. Its input is only the PID returned by the just-spawned child; it is isolated to command-tree cleanup.
- Certificate pinning can cause availability failures during legitimate certificate rotation. Operational deployments need a coordinated pin-rotation process.
- Diagnostics redact known secret patterns and bound output, but pattern-based redaction is not a proof that arbitrary sensitive application data can never appear in local logs.
