---
title: Pi Harness
tags:
  - umbratic
  - harness
  - pi
  - llm-tools
  - security
status: draft
---


### P0: Keep Veil as the production model boundary

For managed or production profiles, the runner should only call Veil chat routes and should not directly call Ollama, vLLM, or public provider endpoints. Client-supplied system prompts should be ignored or rejected in production mode so protected prompt assembly stays inside Veil.

Concrete checks:

- runner config accepts only the managed `company-endpoint` provider in production;
- base URLs must point to approved Veil routes;
- `/prompt_async` should not accept an arbitrary `system` field in production;
- tests should prove that direct runtime endpoints and client-side system override attempts are rejected.

### P0: Harden the local runner HTTP boundary

Umbratic already binds the runner locally and uses a random Basic-auth password. The next hardening layer should cover request parsing and error disclosure.

Concrete checks:

- add max body sizes to local runner JSON parsing;
- redact internal error details from 500 responses;
- return generic errors to the UI while keeping safe diagnostic codes locally;
- set no-store headers on local runner responses.

### P1: Formalize policy middleware

Umbratic already has command classification, blocked paths, redaction, and permission brokering. Turn that into an explicit tool policy pipeline with stable event names and tests.

Suggested stages:

- normalize tool call;
- resolve workspace paths;
- classify command or mutation;
- apply static deny rules;
- request permission when needed;
- execute through selected backend;
- redact and summarize output;
- emit audit and telemetry records.

### P1: Tighten supply-chain checks

Adopt the Pi-style stance that dependency changes are code changes.

Concrete checks:

- exact versions for direct external dependencies;
- `.npmrc` with exact-save and minimum release age;
- lockfile-change review script or CI check;
- install/test paths that use `--ignore-scripts` where possible;
- lifecycle-script allowlist kept small and reviewed;
- CI check for unmanaged dependency ranges.

### P2: Improve skill governance

Umbratic intentionally avoids a public skill marketplace. Keep that. Add stronger local governance instead:

- show skill source and modified status;
- store imported skill checksums;
- allow managed system skills to be reset to known-good content;
- apply workspace trust before project-local skills;
- keep resource byte limits and path traversal protections.
