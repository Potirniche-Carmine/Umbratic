# Umbratic Security Audit — August 2026

**Target:** repository at branch `bucket-harness`, commit `56b2d09` plus working-tree changes.
**Date:** 2026-08-04.
**Scope:** Node/npm and Rust/Go toolchain pinning, dependency supply chain, Electron desktop
app, Rust runner, Veil, and the desktop↔Veil transport and enrollment path.

Out of scope by direction: release signing and distribution, telemetry content policy, and
Veil Console (operated in a locked-down environment).

## Findings

| ID | Severity | Component | Finding |
| --- | --- | --- | --- |
| H-1 | High | Rust runner | `find … -exec` / `-delete` classify as audited read-only and auto-run in Auto-safe mode |
| H-2 | High | Rust runner | The shell tool bypasses the blocked-path secret list that guards the file tools |
| M-1 | Medium | Desktop ↔ runner | The runner password is passed on `argv` |
| M-2 | Medium | Runner ↔ Veil | Certificate pinning is verified after the request body is sent |
| M-3 | Medium | Veil | Identity rate limits key on `RemoteAddr`, which is always `127.0.0.1` behind the proxy |
| M-4 | Medium | Veil | `/api/session` and `/api/session/logout` have no rate limit |
| M-5 | Medium | Desktop credentials | A plaintext device private key is accepted from the credential file |
| L-1 | Low | Toolchain | `.npmrc` omits `engine-strict=true`, so the Node/npm pins are advisory outside CI |
| A-1 | No action | Veil Console | `golang.org/x/crypto/openpgp` advisory — assessed, not remediable by upgrade |

Dependency scans at the time of audit: `npm audit` 0 vulnerabilities; `cargo audit` 0
vulnerabilities and 0 warnings across 169 crates; `govulncheck` reports no vulnerabilities in
either Go module (one module-level advisory, A-1).

---

## H-1 — `find … -exec` and `find … -delete` classify as audited read-only and auto-run

**Location**
- `packages/runner/src/policy.rs:334-349` — first-token classification
- `packages/runner/src/safety.rs:262-269` — `read` → `SafetyAction::Allow`
- `apps/desktop/src/main/policy.ts:250-260` — `canAutoResolvePermission`
- `apps/desktop/src/main/taskRunner.ts:288` — auto-resolve call site

**Fact.** `classify_command_text` ends in a first-token allowlist. When the first word is
`cat`, `type`, `dir`, `ls`, `find`, or `where`, the segment is classified `read` with
`risky: false`. `evaluate_command` maps `read` with no dynamic-syntax marker to
`SafetyAction::Allow`. The desktop auto-resolves any `bash` permission whose
`safetyAction === "allow"` while Auto-safe mode is on. `find` is not read-only.

Verified against the compiled policy engine:

```
find . -type f -exec sh -c id ;      → action=Allow class=read rule=audited_read_only
find . -type f -exec sh -c 'id' \;   → action=Allow class=read rule=audited_read_only
find . -name x -delete               → action=Allow class=read rule=audited_read_only
```

`find -exec` reaches an arbitrary interpreter without matching the network,
external-path, destructive-file, dynamic-syntax, or interpreter rules, each of which
would otherwise force `Confirm` or `Deny`.

**Impact.** In Auto-safe mode, instructions reaching the model from repository content, an
issue body, or a manipulated model response execute arbitrary code and delete workspace
files with no permission prompt and no user interaction.

**Precondition.** Auto-safe is opt-in; `readPermissionModeSetting()` defaults to `normal`
(`apps/desktop/src/main/settingsStorage.ts:374`).

**Fix.** Stop classifying by first token alone. For the `read` class, require the whole
segment to match an allowlist of argument shapes, and reject `find` arguments that execute
(`-exec`, `-execdir`, `-ok`, `-okdir`) or mutate (`-delete`, `-fls`, `-fprint`). Removing
`find` from the auto-allow class entirely also resolves this — it then falls through to
`Confirm`.

---

## H-2 — The shell tool bypasses the blocked-path secret list

**Location**
- `packages/runner/src/policy.rs:76-92` — `is_blocked_path`
- `packages/runner/src/policy.rs:213-215` — enforcement point, file tools only
- `packages/runner/src/policy.rs:250-270` — external-path detection in commands

**Fact.** `resolve_workspace_path` refuses `.env`, `*.pem`, `*.key`, `*.pfx`, `*.p12`,
`id_rsa`, `id_ed25519`, `.npmrc`, `.git/config`, `.git/hooks/*`, and any path containing
`credential`, `secret`, or `token`. That gate covers the `read`, `write`, `edit`, and
`patch` tools. It is never consulted for the `command` tool.

Verified against the compiled policy engine:

```
cat .env             → action=Allow class=read rule=audited_read_only
cat *.env            → action=Allow class=read rule=audited_read_only
cat ..\..\secret.txt → action=Allow class=read rule=audited_read_only
```

The third case is a separate gap in the same code path. The external-path check matches
absolute paths only — `/…` on Unix, `[A-Z]:\` or `\\` on Windows. A POSIX-style
`cat ../../secret` is caught incidentally because the regex matches the `/../…` substring;
a Windows-style `..\..\secret.txt` matches neither pattern and is treated as a workspace-
local read.

**Impact.** The strongest workspace-secret control in the runner is one shell command away
from being inert. In Auto-safe mode the file is read with no prompt and its contents enter
the model context. In `normal` mode the user sees a prompt that reads as a benign `cat`.
The Windows case additionally reads files outside the workspace root.

**Fix.** Parse file-like arguments out of the command segment, resolve them against the
workspace root (handling both separator styles), and apply `is_blocked_path`. Force at
minimum `Confirm`, and `Deny` for blocklist matches to stay consistent with the file tools.

---

## M-1 — The runner password is passed on the command line

**Location** `apps/desktop/src/main/runnerAdapter.ts:309, 320`

**Fact.**

```ts
const password = crypto.randomBytes(18).toString("base64url");
const child = spawn(binaryPath, ["serve", "--hostname=127.0.0.1", `--port=${port}`, `--password=${password}`], …);
```

The runner configuration is handed over on stdin (`child.stdin?.end(...)`, line 326); the
credential is not. Process arguments are readable by any local process via `ps` on macOS
and Linux and via WMI on Windows.

**Impact.** Any local process, including one running as a different unprivileged user, can
read the password and drive the runner's loopback API: start turns and answer permission
prompts with `allow`. That is local escalation to arbitrary code execution in the user's
workspace, gated only by the classifier in H-1 and H-2.

**Fix.** Send the password on the existing stdin channel with the rest of the configuration,
or through an inherited environment variable the runner clears after reading. Remove
`--password` so it cannot be reintroduced.

---

## M-2 — Certificate pinning is verified after the request body is sent

**Location** `packages/runner/src/veil_client.rs:150, 245, 731` and `375-405`

**Fact.** All three Veil call sites use the same order:

```rust
let response = request.json(&body).send().await…;
verify_certificate_pin(&session.config.provider, &response)?;
```

`verify_certificate_pin` reads the peer certificate from `TlsInfo` on the completed
response. By then the handshake has been accepted by the platform trust store and the full
request body — prompt content, workspace excerpts, and the `Authorization: Bearer` session
token — has been transmitted.

The Electron main process does this correctly: `apps/desktop/src/main/providerClient.ts:41-51`
installs the pin check inside `checkServerIdentity`, aborting the handshake before any bytes
are sent.

**Impact.** Runner-side pinning protects response integrity but not request confidentiality.
An attacker holding any certificate the platform trust store accepts for the Veil host —
a mis-issued certificate, a TLS-inspecting proxy, a rogue enterprise CA — receives the
session token and the prompt before the pin check fails.

**Fix.** Move the pin into the TLS layer: install a custom `rustls` `ServerCertVerifier`, or
pre-seed the pinned certificate as the only root via `add_root_certificate` with
`tls_built_in_root_certs(false)`, so a mismatch fails the handshake. Keep the post-response
check as a secondary assertion.

---

## M-3 — Identity rate limits key on `RemoteAddr`, which is always `127.0.0.1` behind the proxy

**Location** `infrastructure/veil/internal/http/server.go:311-351`,
`infrastructure/veil-console/deploy/Caddyfile.template`

**Fact.**

```go
func identityRateKey(r *http.Request, action string) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	…
	return action + "|" + host
}
```

The shipped deployment terminates TLS in Caddy and reverse-proxies to `127.0.0.1:8080`.
`RemoteAddr` is the only client-address source anywhere in the Veil packages; `X-Forwarded-For`
is never read. Every request therefore keys on `127.0.0.1`, so the `enroll` limit of 10/min
and the `challenge` limit of 30/min apply to the whole organization rather than per client.

**Impact.** Two consequences. One client sending eleven enrollment attempts in a minute
blocks every other user's onboarding, repeatedly and cheaply. And the control provides no
per-attacker throttling, which is its purpose.

**Fix.** Read the right-most untrusted hop from `X-Forwarded-For` only when the immediate
peer is a configured trusted proxy; fall back to `RemoteAddr` otherwise. Configure Caddy to
overwrite rather than append the header. Gate this on an explicit setting
(`VEIL_TRUSTED_PROXY_CIDRS`), default empty.

---

## M-4 — `/api/session` and `/api/session/logout` have no rate limit

**Location** `infrastructure/veil/internal/http/server.go:261-295`

**Fact.** `/api/enrollment/enroll` and `/api/session/challenge` both call
`allowIdentityRequest`. `/api/session` — which base64-decodes a signature and performs an
Ed25519 verification — and `/api/session/logout` do not.

**Impact.** Unauthenticated, unbounded work on a public endpoint: CPU consumption and log
volume. Signature forgery is not a concern (Ed25519 with a 96-bit challenge UID). Combined
with M-3, an attacker holding no credential can saturate the shared enroll bucket and hammer
`/api/session` at the same time.

**Fix.** Apply `allowIdentityRequest` to both routes once M-3 gives the limiter a meaningful
key. A limit in the same range as `challenge` is appropriate.

---

## M-5 — A plaintext device private key is accepted from the credential file

**Location** `apps/desktop/src/main/companyCredentialStorage.ts:29-39`

**Fact.**

```ts
export function readProtectedString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  …
}
```

Writes always go through `safeStorage`: `writeProtectedString` throws when OS encryption is
unavailable, and `assertCompanyCredentialStorageAvailable` blocks enrollment outright. Reads
accept a bare string, so an Ed25519 device private key stored in cleartext is used as-is.

**Impact.** The OS-keychain protection is downgradeable by anything that can write the
credential file. There is no integrity check binding the record to the installation, so a
tampered file is indistinguishable from a legitimate one. It is also a compatibility path,
which `AGENTS.md` prohibits.

**Fix.** Delete the plaintext branch. Treat a record whose `privateKeyPkcs8` is not an
`electron-safe-storage-v1` envelope as corrupt: refuse it, clear it, require re-enrollment.

---

## L-1 — `.npmrc` omits `engine-strict=true`

**Location** `.npmrc`, `package.json` (`engines`), `scripts/check-supply-chain.ts:63-77`

**Fact.** `.npmrc` sets `save-exact=true`, `ignore-scripts=true`, `min-release-age=14`, and
`fund=false`. It does not set `engine-strict=true`, so `engines.node: "26.3.0"` and
`engines.npm: "11.16.0"` are advisory on developer machines — npm warns and proceeds. CI
enforces the version via `node-version-file: .nvmrc`, so the gap is local only.

**Verified safe to enable.** All 226 packages in `package-lock.json` that declare `engines`
were checked against Node 26.3.0 and npm 11.16.0 with `semver.satisfies`: **0 conflicts**.
An empirical `npm ci --dry-run --ignore-scripts --omit=peer --engine-strict` completes
successfully.

**Fix.** Add `engine-strict=true` to `.npmrc`, and add it to the required settings map in
`scripts/check-supply-chain.ts` so it cannot silently regress.

---

## A-1 — `golang.org/x/crypto/openpgp` advisory: assessed, no action

**Location** `infrastructure/veil-console/internal/auth/auth.go:13`,
`infrastructure/veil-console/go.mod`

**Advisory.** `GO-2026-5932` — "The golang.org/x/crypto/openpgp package is unmaintained,
unsafe by design, and has known security issues." Found in `golang.org/x/crypto@v0.54.0`.
**Fixed in: N/A.**

**Fact.** The package is not reachable. `govulncheck` reports it under *Module Results*
only — 0 vulnerabilities in called symbols, 0 in imported packages. The single import from
that module is:

```go
"golang.org/x/crypto/argon2"   // auth.go:13
```

`go list -deps ./...` confirms the only compiled packages from the module are
`golang.org/x/crypto/argon2` and its dependency `golang.org/x/crypto/blake2b`. The
`vendor/golang.org/x/crypto/*` entries in that output are the Go standard library's own
vendored copies used by `crypto/tls`, unrelated to this module requirement.

**Alternatives evaluated.**

| Option | Verdict |
| --- | --- |
| Upgrade `golang.org/x/crypto` | No effect. The advisory is a permanent deprecation notice with `Fixed in: N/A`; it will follow every future version. |
| Replace Argon2id with a stdlib KDF | Rejected. Go 1.26 ships `crypto/pbkdf2` and `crypto/hkdf` but no Argon2 (verified with `go doc`). PBKDF2 is not memory-hard; swapping Argon2id for it to silence an unreachable advisory is a net security loss. |
| Third-party Argon2 implementation | Rejected. Trades the Go team's own module for a package with weaker provenance, against the repository's dependency policy. |
| Vendor `argon2` + `blake2b` only | Possible. Removes the module requirement and the advisory, at the cost of owning and patching the code. Not worth it for an unreachable finding. |

**Conclusion.** Keep `golang.org/x/crypto/argon2`. The correct handling is to record this as
a known, accepted, module-scoped advisory so a future `govulncheck` run is not mistaken for
a regression. If a zero-output scan is required for reporting, add a scoped suppression
rather than changing the password hash.

---

## Remediation Order

1. **H-1 and H-2** — one change to the command classifier addresses both. These are the only
   findings that turn untrusted repository content into unattended code execution.
2. **M-1** — small change, large reduction in local attack surface.
3. **M-5**, then **M-2** — scoped credential-handling fixes.
4. **M-3 and M-4** — one trusted-proxy change makes both limits meaningful.
5. **L-1** — one line in `.npmrc` plus one in the supply-chain check.

## Reproducing

```bash
npm run supply-chain:check
npm run supply-chain:audit
```

The classification results in H-1 and H-2 reproduce by adding a temporary integration test
under `packages/runner/tests/` that calls `umbratic_runner::safety::evaluate_command` with the
listed command strings and asserts on `decision.action`, `decision.command_class`, and
`decision.rule_id`. Those cases belong in the permanent suite once H-1 and H-2 are fixed, as
regression coverage for the auto-allow boundary.
