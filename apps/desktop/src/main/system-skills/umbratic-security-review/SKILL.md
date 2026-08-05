---
name: Security Review
description: Use for defensive security review, vulnerability analysis, and threat modeling of code in this workspace, covering scope, trust boundaries, vulnerability classes, and a severity-ranked reporting rubric.
---

# Security Review

A defensive review of code that is already in the workspace. Depth on a chosen risk surface beats shallow coverage of every file.

This skill produces findings: evidence, impact, and fix guidance. It never produces exploit proofs-of-concept, weaponized payloads, or attacks against running systems.

## 1. Scope ritual

Do this before any heavy tool use.

- **Named paths, services, or a diff** — that is the surface. Start immediately.
- **"The entire repo" on a large tree** — stop and ask first: which apps or packages, which threat priorities (auth, secrets, injection, supply chain, …), and what "done" means. Do not open a whole-tree read loop.
- **Vague "make this secure"** — default surface is entrypoints, authn/authz, secret handling, dangerous sinks, config, and permission checks.

Set a read budget before starting: roughly 25–40 substantive file reads per pass unless the user widens scope. When the budget is spent, synthesize. Every report ends with an explicit **Not covered** section. Opening many files is not coverage.

## 2. Method

Targeted `search` waves, then selective `read` of the highest-signal hits. Use `grep` only to confirm an exact pattern. Never enumerate the tree with recursive `ls`/`find` as a substitute for review.

Rank hits before opening them. Do not open every result of a search.

## 3. Trust boundaries

Map these first — most real findings sit on one:

- External HTTP handlers, IPC channels, and message consumers
- Authentication and authorization edges
- Multi-tenant or per-user data separation
- Filesystem roots and path confinement
- Subprocess and shell boundaries
- Model, tool, and plugin boundaries in LLM-facing systems

## 4. Authentication and authorization

Session and token handling, lifetime, and revocation. Password storage and hashing. MFA gaps. Privilege escalation paths. Missing object-level authorization (IDOR). Role checks present on reads but missing on mutations.

## 5. Secrets

Hardcoded keys and credentials. `.env` files reachable by tooling. Secrets in logs, telemetry, error messages, or crash dumps. Tokens in URLs or query strings. Private keys committed to the repo. Redaction that only covers the happy path.

## 6. Injection

Command injection and shell interpolation. SQL and NoSQL injection. Template and server-side template injection. Path traversal. Unsafe deserialization. XSS where a web UI renders untrusted data. Prompt-injection surfaces where model output reaches a privileged sink.

## 7. SSRF and outbound requests

User-controlled URLs. Link-local and cloud metadata addresses. Redirect following. Missing allowlists on outbound hosts.

## 8. Filesystem

Symlink escape from a confined root. Root confinement checks that resolve after rather than before use. Upload and download path rules. Archive extraction paths.

## 9. Crypto and transport

Weak or disabled TLS verification. Cookie flags (`Secure`, `HttpOnly`, `SameSite`). CSRF protection on state-changing routes. CORS misconfiguration, especially reflected origins with credentials.

## 10. Supply chain and build

Unpinned or floating dependencies. Install and postinstall scripts. Binaries downloaded at build time. Lockfile integrity. CI steps that run untrusted input with elevated credentials.

## 11. Concurrency and TOCTOU

Check-then-act on files, permissions, or quotas. Races between validation and use. Shared mutable state reachable from concurrent request handlers.

## 12. Denial of service and resource use

Unbounded reads or allocations driven by untrusted input. Decompression bombs. Synchronous blocking on attacker-controlled work. Missing timeouts and caps. Report these only where there is evidence, not as boilerplate.

## 13. Reporting rubric

Order findings by severity. For each one give:

- **Severity** — critical / high / medium / low / info
- **Evidence** — exact path and symbol, with the relevant lines
- **Impact** — what an attacker gains, and what they need first
- **Fix** — the concrete change, not "validate input"

Then group everything under three headings:

- **Confirmed** — you read the code and the issue is real
- **Needs validation** — plausible from the code but depends on runtime or config you could not see
- **Not covered** — surfaces the budget or scope excluded

Never present "needs validation" as confirmed. A precise, honest gap list is worth more than a padded finding list.

## 14. Anti-loop

- After several similar searches yield no new class of finding, stop and synthesize.
- Do not repeat an equivalent failing or empty search with different wording.
- One deep pass plus clear gaps beats an endless second pass.
- Read-only by default. Fix only if the user asked for fixes.
