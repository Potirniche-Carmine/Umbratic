---
tags: [aegis, opencode, fork, runner, security, local-first]
status: draft
last_updated: 2026-05-06
---

# Aegis Runner — Fork & Strip Plan

Concrete plan for forking OpenCode, stripping it to the minimum Aegis needs, rebranding the whole thing as Aegis (no "OpenCode" anywhere in the fork), and dropping it in behind the existing package adapter so the rest of the app doesn't notice the swap.

Two principles drive every step:

- **Security and privacy first.** If a code path could exfiltrate, update itself, or talk to anything other than the one allowed model endpoint, it gets *deleted* (not configured off). Disabled-by-default is not a defense — code on disk is attack surface.
- **Simple to keep alive.** What survives the strip should be small enough that one person can read the whole runner in an afternoon and reason about it. Future work (sub-workers, debugger, RAG) bolts onto a small core.

Frame: see [[README]] for current Aegis state, [[Things to do]] §2 for the queue, and [[Things_to_do_Research]] §2 for the rationale on egress-first hardening.

---

## What "done" looks like

A new package in the Aegis repo: `desktop/runner/` (or a workspace member, e.g. `@aegis/runner`). It exposes a single TypeScript entrypoint, has no `opencode` string left in it, depends on nothing from `opencode-ai` or `@opencode-ai/sdk`, and ships a single binary per platform. The desktop main process imports it instead of spawning the OpenCode binary.

Concretely:

```text
desktop/
  runner/                ← the fork, fully rebranded
    src/
      cli.ts             ← `aegis-runner serve --port=… --password=…`
      server.ts          ← HTTP + SSE
      loop.ts            ← agent turn loop
      provider/
        local.ts         ← OpenAI-compatible client (one provider)
      tools/
        read.ts
        write.ts
        edit.ts
        search.ts
        command.ts       ← (renamed from bash)
      permission.ts
      session.ts
      events.ts          ← AegisRunnerEvent emission
      policy.ts          ← Aegis-native primitives (moved from desktop/src/main)
    bin/
      aegis-runner       ← compiled binary (per platform via pkg/bun)
    package.json         ← name "@aegis/runner", no public deps beyond ai SDK + node stdlib
  src/
    main/
      opencodeHarness.ts ← becomes runnerAdapter.ts; spawns aegis-runner instead
```

When the cutover is done, `desktop/package.json` no longer lists `opencode-ai`, `@opencode-ai/sdk`, or any `opencode-<platform>-<arch>` package.

---

## Step 0 — Pre-fork seam (do this first, no fork yet)

The fork lands behind a stable adapter so the renderer never knows the swap happened. Build that seam against the current packaged OpenCode first; the fork drops into the same shape later.

1. **Define the interface** in `desktop/src/main/runner.ts`:

    ```ts
    export interface AegisRunner {
      start(task: TaskRecord, model: LocalModelInfo, models: LocalModelInfo[]): Promise<RunnerHandle>;
      sendPrompt(handle: RunnerHandle, prompt: string): Promise<void>;
      replyPermission(handle: RunnerHandle, permissionId: string, allow: boolean): Promise<void>;
      abort(handle: RunnerHandle): void;
      events(handle: RunnerHandle): AsyncIterable<AegisRunnerEvent>;
    }
    ```

2. **Define `AegisRunnerEvent`** as the renderer-facing event shape:

    ```ts
    export type AegisRunnerEvent =
      | { type: "assistant.delta"; taskId: string; text: string; at: string }
      | { type: "assistant.reasoning.delta"; taskId: string; text: string; at: string }
      | { type: "tool.requested"; taskId: string; toolCallId: string; toolKind: string; commandClass: string; summary: string; cwd: string; at: string }
      | { type: "tool.output"; taskId: string; toolCallId: string; stream: "stdout" | "stderr"; text: string; redacted: boolean; at: string }
      | { type: "tool.finished"; taskId: string; toolCallId: string; exitCode: number | null; at: string }
      | { type: "permission.requested"; taskId: string; permissionId: string; permissionKind: string; summary: string; at: string }
      | { type: "permission.resolved"; taskId: string; permissionId: string; decision: "allow" | "deny"; at: string }
      | { type: "runner.error"; taskId: string; category: string; message: string; at: string };
    ```

3. **Translate at the adapter, not in the renderer.** Today `desktop/src/main/opencodeHarness.ts` parses OpenCode SSE blocks; the renderer touches OpenCode event shapes. Move all OpenCode-specific shapes into the adapter — the renderer consumes only `AegisRunnerEvent`.

4. **Rename** `aegisRunnerVersion = "opencode-package-adapter"` → `"package-adapter-1"` in `desktop/src/main/policy.ts:9`. Reserve `"fork-1"` for the post-cutover value.

When this is done, the fork is a swap — not a rewrite.

---

## Step 1 — Get the source under Aegis control

Two viable shapes; pick one before cutting code.

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **Vendored fork** | Copy the relevant subset of OpenCode source into `desktop/runner/` as new files; no upstream remote. | Smallest mental model. No merge conflicts ever. Easiest to delete things. | No automatic security backports — you own everything. |
| **Forked git remote** | Fork `sst/opencode` to a private GitHub org. Pull the subset into `desktop/runner/` via subtree or sparse checkout. Remote `aegis-fork` exists for cherry-picking upstream fixes if needed. | Optional upstream backports. Audit trail. | Tempting to merge upstream junk; merge burden if you do. |

**Recommendation: vendored fork.** The strip is aggressive enough that `git merge upstream/main` will fight you on every file. Cherry-pick by hand if a specific fix matters. The audit story is "we own this code" — cleaner than "we own a fork that diverges."

Concrete:

```bash
# 1. Clone upstream temporarily for source extraction
git clone --depth 1 https://github.com/sst/opencode /tmp/opencode-upstream

# 2. Note the upstream commit SHA in desktop/runner/UPSTREAM.md (provenance, not a remote)
git -C /tmp/opencode-upstream rev-parse HEAD > /dev/null  # write into UPSTREAM.md manually

# 3. Create the new workspace member
mkdir -p desktop/runner/src desktop/runner/bin
```

Add `desktop/runner` to the `workspaces` array in the root `package.json`.

`desktop/runner/UPSTREAM.md` records: upstream repo URL, commit SHA, license terms, and the date/scope of the strip. This is the provenance file for the audit.

---

## Step 2 — Copy only what survives

OpenCode is large. Copy *only* these subsystems into `desktop/runner/src/`. If a file is not on this list, don't copy it.

**Keep:**

- The agent turn loop (the part that converts a chat history + tool results into the next model call and dispatches tool calls).
- The OpenAI-compatible provider client. Strip down to one client class with `baseURL`, `apiKey`, `model`, streaming support, and tool-call parsing.
- Tool implementations: file read, file write, file edit, glob/search, shell command. Nothing else.
- Permission request/reply machinery (the part that asks the host to approve a tool call).
- Per-session state (one session = one task).
- The headless server's HTTP entry: route registration, Basic-auth check, SSE event stream, `/permission/<id>/reply`, session lifecycle endpoints. Strip to the minimum the desktop adapter calls.
- The CLI entry that boots the server (`serve --port --password`-shaped). Aegis spawns it; nothing else needs a CLI.

**Do not copy** the rest of the upstream tree, even "just in case." Files copied are files you own.

After copy, run `tsc` and chase missing imports. Each missing import is either a thing to add to the keep list (rare) or a thing to delete (common).

---

## Step 3 — Strip providers

OpenCode ships adapters for every public provider. Aegis allows exactly one (LM Studio loopback today, a company-server endpoint later). The fork should not have an "add a provider" code path at all.

**Delete the directories/files** that implement: OpenAI, Anthropic, Google, Gemini, OpenRouter, xAI, Bedrock, Azure, Groq, Mistral, Cohere, Together, Perplexity, the OpenCode-cloud provider, anything else. The provider registry / loader / discovery code goes too — there's no registry; there's one client.

**Replace with `desktop/runner/src/provider/local.ts`**:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type AegisProviderConfig = {
  id: "local-lmstudio" | "company-model";
  name: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
};

export function createProvider(config: AegisProviderConfig) {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|ai\.[a-z0-9.-]+\.internal)/i.test(config.baseURL)) {
    throw new Error(`provider baseURL not on the Aegis allowlist: ${config.baseURL}`);
  }
  return createOpenAICompatible({ name: config.name, baseURL: config.baseURL, apiKey: config.apiKey });
}
```

The provider id is a TypeScript union (one or two variants) — not a string parsed at runtime. Adding a third provider is a code change, not a config change. That's deliberate.

Delete any `enabled_providers` / `disabled_providers` config fields. There's nothing to enable or disable.

---

## Step 4 — Strip share, cloud, and external auth

OpenCode has a "share this session as a URL" feature, plus cloud sign-in flows. Both go.

**Delete:**

- Share link generation, share upload, share import, share export, anything that serializes a session for transmission.
- Cloud sign-in (browser-redirect OAuth, magic-link, anything that opens a browser to authenticate against a third-party).
- API-key vault helpers. Aegis hands the runner a key directly; the runner has no notion of "vault" or "credential storage."
- The `share` and `autoupdate` config fields. They can't be `disabled` if they don't exist.

**Allow** (added later, not now): an SSO-bearer auth mode for the `company-model` provider. That's a single header on the model request — not a "login flow."

---

## Step 5 — Strip telemetry, analytics, crash reporting

Anything that calls a third-party host without an explicit task starting it.

**Delete:**

- Posthog/Sentry/Mixpanel/Datadog/Segment/anything-similar SDK imports and the `track()`/`capture()` call sites.
- Crash reporters that ship stack traces off-machine.
- "Anonymous usage" pings on startup.
- "Phone home for the latest version" pings.
- Any module that constructs a URL from `process.env.<VENDOR>_URL` for non-model traffic.

**Replace with** an in-process event emitter that emits `AegisRunnerEvent` on stdout/SSE. The Aegis main process is the only consumer. Nothing leaves the machine without going through the model endpoint.

`grep -rEi "posthog|sentry|mixpanel|datadog|segment|amplitude|telemetry|analytics" desktop/runner/src/` should return zero hits after this step.

---

## Step 6 — Strip auto-update

OpenCode auto-updates its own binary. Aegis owns its release cadence; the runner ships with the app.

**Delete:**

- The updater module (whatever name it has — usually `update.ts`, `autoupdate.ts`, or in a `cli/` subdirectory).
- "Check for newer version" calls on startup.
- Update-channel config fields (`stable`, `beta`, `nightly`).
- Self-replace logic.
- The `autoupdate` config field.

If the desktop app needs to update the runner, it does so by shipping a new desktop release. The runner has no opinion on its own version beyond reporting it.

---

## Step 7 — Strip web tools

Web search and web fetch are not Aegis tools. The model has the local repo, the local shell (sandboxed), the local files. Nothing else.

**Delete:**

- The web-search tool (Exa, Tavily, SerpAPI, whatever the upstream wires up).
- The web-fetch / URL-read tool.
- Any HTTP client that makes outbound non-loopback calls.
- The webfetch/websearch permission entries (the deny config disappears with the tools).

`grep -rEi "exa|tavily|serpapi|brave[_-]search|google[_-]search" desktop/runner/src/` should return zero hits.

---

## Step 8 — Strip MCP and plugins

External tool buses are useful in a general agent. They're a footgun in a sovereign agent.

**Delete:**

- The MCP client/server modules.
- The plugin loader (any code that calls `require()` or dynamic `import()` based on config).
- The plugin registry / marketplace UI hooks.
- The MCP/plugin config fields.

If a future Aegis feature needs MCP-like behavior, it ships as a typed tool inside `desktop/runner/src/tools/` — written, audited, and signed by Aegis. Not loaded from disk at runtime.

---

## Step 9 — Strip broad home-directory loading

OpenCode reads from `~/.config/opencode/`, `~/.opencode/`, sometimes `$XDG_CONFIG_HOME/...`. Each of those is an injection vector.

**Delete:**

- All home-directory reads for prompts, skills, instructions, configs, credentials.
- Loaders that walk parent directories looking for `.opencode*` files.
- Global rule files / global instruction files / global agent files.

The runner reads exactly two things at startup:
1. The config object passed to it via `OPENCODE_CONFIG_CONTENT` (rename to `AEGIS_RUNNER_CONFIG`) by the desktop main process.
2. The cwd's repo files, but only through tool calls during the session.

That's it. No filesystem walks for hidden config.

---

## Step 10 — Rebrand: zero "OpenCode" left

This is mechanical but important. The fork is Aegis. No user, customer, security reviewer, or future maintainer should see the upstream name in the source.

**Find-and-replace pass** (case-insensitive, but preserve target case style):

| From | To |
|---|---|
| `OpenCode` (PascalCase) | `AegisRunner` |
| `opencode` (lower) | `aegis-runner` |
| `OPENCODE_` (env prefix) | `AEGIS_RUNNER_` |
| `opencode.ai` (URLs in comments) | (delete reference) |
| `opencode.json` (config filename) | `aegis-runner.json` |
| `@opencode-ai/sdk` (imports — should be gone) | (deleted) |

**File-level renames:**

- `bin/opencode` → `bin/aegis-runner`
- Anything else with `opencode` in the basename gets the same treatment.

**Class/type/function renames:**

- `OpenCodeServer` → `AegisRunnerServer`
- `OpenCodeSession` → `AegisRunnerSession`
- `OpenCodeProvider` → drops to `LocalProvider` or `CompanyProvider`.
- Strings in user-facing error messages: `"OpenCode failed."` → `"Aegis runner failed."`

**Commit/license attribution stays.** `UPSTREAM.md` records that the source originated from `sst/opencode` at commit SHA X with license Y. That's the audit story: "this is a stripped fork of opencode, here's the lineage." But the runtime code never says so.

**Verification gate** (becomes a CI check in step 13):

```bash
# Should be zero hits across desktop/runner/src/, except in UPSTREAM.md / LICENSE.
grep -rEi "opencode" desktop/runner/src/ desktop/runner/bin/
```

---

## Step 11 — Add Aegis-native primitives inside the loop

Today, `desktop/src/main/policy.ts` sits *outside* OpenCode and post-filters its output. The fork moves these *inside* so a violation can't slip past a missed adapter check.

Move from `desktop/src/main/policy.ts` and `desktop/src/main/config.ts` into `desktop/runner/src/policy.ts`:

- `aegisPolicyVersion`, `aegisRunnerName`, `aegisRunnerVersion`, `aegisRunnerContractVersion`.
- `isBlockedPath`, `isGeneratedRuntimePath`.
- `classifyCommandText` and the `CommandClass` enum.
- `redactText`, `redactCommandText`.
- `pythonRuntimeSystemPrompt` and the runtime-profile detectors.
- `permissionRulesForMode`.

The shell-command tool calls `classifyCommandText` *before* dispatching. The file-write tool calls `isBlockedPath` *before* writing. The event emitter calls `redactText` *before* emitting `tool.output`. None of these are post-hoc — they're inside the loop.

After the move, `desktop/src/main/policy.ts` shrinks to whatever the desktop process specifically needs (path utilities, IPC validators). The runtime guards live in the runner.

---

## Step 12 — Simplify the surface

Once the strip is done, sweep for dead complexity. The smaller the surviving runner, the easier it is to maintain. Aim for **under ~3,000 lines** in `desktop/runner/src/` total. Upstream is many times that — most of the volume is the providers, share, MCP, plugin loader, web tools, and update path you've already deleted, but there will be helpers that only existed to serve those subsystems.

Look for and delete:

- "Multi-provider routing" abstractions left behind after the providers are gone.
- Capability-detection code (e.g. "does this provider support tool calls?") — there's one provider; just call the tool.
- Token-counting heuristics that only differed across providers.
- Configuration-shape compatibility shims for old config versions.
- Logging subsystems with three log levels and a sink registry — replace with a single `console.error`-shaped helper.
- Generic "registry" abstractions that hold one entry now.

Rule: if a file has fewer than two callers and was a layer over something deleted, fold it into the caller.

---

## Step 13 — Security regression tests

Make the strip stick. These tests live in `desktop/runner/src/__tests__/` and run in CI on every PR.

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts") && !full.includes("__tests__")) yield full;
  }
}

const FORBIDDEN = [
  /opencode/i,                               // step 10 — no upstream name in source
  /\bposthog\b|\bsentry\b|\bmixpanel\b/i,    // step 5 — no telemetry SDKs
  /\bexa\b|\btavily\b|\bserpapi\b/i,         // step 7 — no web search
  /api\.openai\.com/i,                       // step 3 — no public providers
  /api\.anthropic\.com/i,
  /generativelanguage\.googleapis\.com/i,
  /openrouter\.ai/i,
  /\bautoupdate\b|\bself[_-]?update\b/i,     // step 6 — no updater
  /https?:\/\/(?!127\.|localhost|\[::1\]|ai\.[a-z0-9.-]+\.internal)/i, // any non-allowed URL
];

test("source contains no forbidden patterns", () => {
  for (const file of walk("desktop/runner/src")) {
    const text = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) {
      const match = text.match(pattern);
      if (match) throw new Error(`${file} contains forbidden pattern ${pattern}: ${match[0]}`);
    }
  }
});
```

Plus runtime tests:

- **Egress test.** Start the runner, send one trivial prompt, assert `pktmon`/`tcpdump` recorded zero non-loopback (and non-allowlisted-company-host) destinations.
- **Permission denial test.** Try to write to `.env`, `id_rsa`, anything matching `isBlockedPath`. Assert the write is refused at the tool layer.
- **Bare-python test.** Send a prompt that nudges the model toward `python script.py`. Assert the command classifier flags it and the verifier rejects it.

These are the tests that catch a future "convenient" import re-introducing what step 3-9 deleted.

---

## Step 14 — Wire to the Aegis adapter

Replace `desktop/src/main/opencodeHarness.ts` with `desktop/src/main/runnerAdapter.ts`. Same shape (the `AegisRunner` interface from step 0), different implementation.

Concrete changes:

- `opencodeBinaryPath()` → `aegisRunnerBinaryPath()`. Resolves to `desktop/runner/bin/aegis-runner` (or per-platform packaged binary).
- `buildOpenCodeConfig` → `buildRunnerConfig`. Returns the Aegis-native config shape (one provider, one model, one allowlist).
- `assertOpenCodeConfig` deletes — there's no upstream config to validate. The runner enforces its own invariants from inside.
- `openCodeHardeningEnvironment` deletes — those env vars don't exist anymore. The hardening lives in the source, not in env flags.
- The SSE parser stays but reads `AegisRunnerEvent` directly (no translator).
- `OPENCODE_CONFIG_CONTENT` → `AEGIS_RUNNER_CONFIG`.
- `OPENCODE_SERVER_PASSWORD` → `AEGIS_RUNNER_PASSWORD`.

Run the existing fixture tasks (Python, Markdown, CMake) end-to-end. Diffs and approvals must match the package adapter's behavior. If something differs, the runner is wrong — fix it before cutover.

---

## Step 15 — Cutover and dependency removal

Once tests are green and fixtures pass:

1. Remove from `desktop/package.json` `dependencies`:
    - `opencode-ai`
    - `@opencode-ai/sdk`
    - All `opencode-<platform>-<arch>` packages.
2. Update `desktop/src/main/policy.ts:9`: `aegisRunnerVersion = "fork-1"`.
3. Update `desktop/src/main/policy.ts:8`: `aegisRunnerName = "AegisRunner"` (no longer "OpenCodeRunner").
4. Run `npm install` in the workspace; verify lockfile drops the upstream packages.
5. Run the full fixture suite once more.
6. Run the security regression tests once more.
7. Tag the release.

Keep the package adapter behind a feature flag (`AEGIS_USE_PACKAGE_ADAPTER=1`) for one release as an emergency rollback. Delete it the release after.

---

## Repository-shape summary

After cutover, the desktop tree looks like:

```text
desktop/
  package.json           (no opencode deps)
  src/main/
    main.ts
    runnerAdapter.ts     (replaces opencodeHarness.ts)
    config.ts            (slimmed; runtime profiles moved to runner)
    policy.ts            (slimmed; classifier/redactor moved to runner)
    storage.ts
    telemetry.ts         (Aegis-side event recording, not third-party SDK)
    types.ts
    utils.ts
  src/preload/
  src/renderer/
  runner/                (the fork)
    UPSTREAM.md
    package.json         (name "@aegis/runner")
    bin/aegis-runner     (per platform)
    src/
      cli.ts
      server.ts
      loop.ts
      provider/local.ts
      tools/{read,write,edit,search,command}.ts
      permission.ts
      session.ts
      events.ts
      policy.ts
      __tests__/
        forbidden-patterns.test.ts
        egress.test.ts
        permissions.test.ts
```

A new contributor reading `desktop/runner/src/` should see: one agent loop, five tools, one provider client, an HTTP+SSE server, a policy module. No marketplaces, no plugin loader, no telemetry SDK, no auto-update path. Nothing to disable — only things to read and change.

---

## What this enables next (not part of the strip)

Once the small core is in place, future improvements (from [[Things to do]] / [[Things_to_do_Research]]) become local edits instead of fights with upstream:

- **Sub-workers** ([[Things_to_do_Research]] §4): add a `delegate(task, files?, return_format)` tool in `tools/` that spawns a second runner instance with a smaller model. The orchestrator runner stays oblivious.
- **Local RAG** ([[Things_to_do_Research]] §5): add `tools/search-semantic.ts` backed by sqlite-vec + cAST chunks. The vector index is per-project under `.aegis/index/`.
- **Light debugger** ([[Things_to_do_Research]] §7): add `tools/debug.ts` speaking DAP to `lldb-dap`. Worker-pattern delegation keeps frame dumps out of the orchestrator's context.
- **Per-language runtime hardening** ([[Things_to_do_Research]] §6): the runtime profiles already moved into `runner/src/policy.ts` (step 11) — extend with Node/pnpm, Rust/cargo, Go.
- **Approval UX** ([[Things_to_do_Research]] §8): pure renderer change — the runner's permission protocol doesn't shift.
- **Bundled CLI tools** ([[Things_to_do_Research]] §1): ripgrep/fd/bat/jq/yq sit in `extraResources` and the runner's `command.ts` resolves them via `process.resourcesPath`. No runner change needed.
- **Enterprise tier** ([[../AI Project/Enterprise_Backend_and_Local_POC]]): swap `provider.id` to `company-model` and the `baseURL` to the company server. Same code path; different config.

---

## Sources

- [[README]] — current Aegis state.
- [[Things to do]] — fork item is #2.
- [[Things_to_do_Research]] §2 — egress-first heuristic.
- [[../AI Project/Enterprise_Backend_and_Local_POC]] — local vs. company-server endpoint.
- [[../AI Project/MVP_Implementation_Plan]] — runner-boundary discipline.
- [[../AI Project/Sovereign_Coding_Agent]] — broader product context.
- [[../AI Project/Harness_Design_Principles]] — harness/runner expectations.
- [[../AI Project/Private_Telemetry_and_Learning_Loop]] — telemetry shape the runner must support.
