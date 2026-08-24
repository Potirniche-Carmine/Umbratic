# Plugins And Connectors

A proposal, not a description of what ships today. It covers how the rest of
the field builds plugins, what Umbratic already has, and the one structural
choice that makes a connector ecosystem worth having here: the capability half
of a plugin runs on the company server, not on the employee's laptop.

Nothing in this document is implemented. Where it conflicts with the repository
`AGENTS.md` — which says Umbratic is not a public connector platform — that
conflict is deliberate and called out at the end.

## The Short Version

Split the plugin in two.

- **Instructions** — skills — ship to the device. That layer already works.
- **Capabilities** — anything holding a credential or reaching Jira,
  Confluence, Bitbucket, or Slack — run on the company server next to Veil,
  supervised by Console, reached through one narrow tool surface.

Every other harness ships both halves to the laptop under the developer's own
personal access token. That is reasonable when the model vendor is already
trusted with everything. It is the wrong shape for a product whose claim is
that the data never leaves the customer's machines.

The sentence that sells it: your connectors run where your model runs.

## What The Field Does

The vocabulary is noisy — plugins, extensions, blocks, tools, functions,
pipelines — but there are only three things underneath it.

| Layer | What it is | State of the art |
| --- | --- | --- |
| Instructions | A folder with `SKILL.md` and YAML frontmatter | Open standard since December 2025; roughly 40 clients read the same files. Three-tier progressive disclosure: name and description at startup (~100 tokens each), body on activation, `references/` and `scripts/` only when the body points at them. |
| Capabilities | MCP servers over stdio or streamable HTTP | Spec revision 2026-07-28. The extensions track adds Tasks for long-running work and Apps for inline UI; a Skills-over-MCP working group is defining how skills travel over the same wire. |
| Packaging | A manifest bundling skills, MCP servers, subagents, hooks, and settings | Usually distributed as a git repository of manifests. |

How specific harnesses put those together:

| Harness | Unit of extension | Where the code runs | Worth taking |
| --- | --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json` bundling skills, agents, hooks, MCP, LSP | Laptop; marketplace plugins copied to a versioned cache, dependencies installed with `npm ci --ignore-scripts` | Install scopes (user / project / local / managed), `userConfig` with `sensitive: true` routed to the OS keychain, workspace-trust gating, plugin-root path indirection |
| Cursor | Marketplace plugin: MCP, skills, subagents, hooks, rules | Laptop, plus remote MCP endpoints | Curated partner launch instead of an open flood; private team marketplaces as the enterprise tier |
| Goose | Extensions, MCP only | Laptop; Rust host, one config for CLI and desktop | Proof that a Rust harness on local models can live on MCP alone |
| Open WebUI | Tools (model-callable), Functions (lifecycle hooks), Pipelines (a separate service) | Pipelines is its own container the UI talks to as an OpenAI-compatible backend | The self-hosted world already moved heavy capability out of process and onto the server |
| Zed | WASM components against a versioned WIT interface | Sandboxed `wasm32-wasip2`, no ambient filesystem or network | The only credible answer if third-party code ever runs on a user's machine |
| Onyx | 40+ ingest connectors with permission sync | Self-hosted, supports air-gapped with local models | The honest competitor. Read their permission-sync design before writing ours. |

Cursor's framing is the most useful line in the survey: a plugin is an MCP
server bundled with the skill that teaches the agent how to use it. Tools give
the model reach; the skill gives it judgement. Ship one without the other and
the model can call `jira_search` with no idea when to.

One correction to a premise worth stating plainly, because a technical buyer
will catch it: the private-AI world does have connector platforms. Onyx, Dify,
LibreChat, and Open WebUI all connect Confluence and Jira and all self-host.
What none of them have is an agentic harness — workspace tool loop, approvals,
worktree review — on a private model with those connectors inside the same
perimeter. The gap is real, and narrower than "nobody does this."

## What Umbratic Already Has

Most of the hard part is built.

| Already shipped | Where | Why it matters |
| --- | --- | --- |
| Agent Skills, implemented: `SKILL.md` with frontmatter, bundled system skills, per-skill enable, harness profiles, zip import with entry and size caps, a SHA-256 manifest that distinguishes "the user edited this" from "we installed this" | `apps/desktop/src/main/skills.ts`, `apps/desktop/src/main/system-skills/`, `apps/desktop/src/shared/harnessSkills.ts` | The cross-vendor content format is already the one we read. A plugin's skill half needs no new format, only provenance and signing. |
| Progressive disclosure, implemented: catalog metadata to the model, body resolved at preflight and cached by content hash, `read_skill` confined to its own folder | `packages/runner/src/skill_preflight.rs`, `packages/runner/src/tools/skill.rs` | The three-tier model the industry standardized on runs in production Rust today. |
| A private, revocable distribution rail: R2 behind a Worker, tokens minted offline by each customer's Veil from `HMAC(master key, org UID)`, thirty-day validity, KV revocation | `docs/update-feed.md`, `infrastructure/downloads-worker/` | A plugin catalog is one more prefix in that bucket: entitlement-scoped and revocable, which is more than a git-repo marketplace can say. |
| A wire contract that already expects this: the golden fixture asserts a skill carrying `source: "marketplace"`, `revision`, `tags`, and `trust: {signed: true}` passes through untouched | `infrastructure/veil/internal/policy/future_harness_test.go` | Skill provenance ships without a Veil release. |
| A server that can host connectors: identity and device enrollment, per-user access, process supervision for vLLM, document extraction, chunking, embedding, Qdrant | `infrastructure/veil-console/internal/supervisor`, `access`, `rag`, `extract` | Supervising a connector process is the same muscle as supervising a model process. Confluence ingestion is the same pipeline as admin document upload. |
| Capability discovery by feature name on `/api/health` | `infrastructure/veil/internal/http/server.go` | `connectors` is the correct gate, under the existing rule that security-semantic fields are never sent optimistically. |

## Three Constraints

The obvious design — map every MCP tool from every connector onto the model's
tool surface, as every other harness does — breaks against all three at once.

- **Thirty-two tools, 128 KB.** `MaxTools = 32` and `MaxToolBytes = 128 * 1024`
  in `infrastructure/veil/internal/policy/request.go`. Five typical MCP servers
  are around 58 tools and 55k tokens of schema. One Jira server would eat the
  budget, and bounds are not relaxed client-side to make a payload fit.
- **The surface is frozen.** `packages/runner/src/tools/surface.rs` resolves the
  whole tool surface once per task so step N declares byte-identical schemas to
  step 1, and `tools/catalog.rs` generates the model-facing schema and the
  executing validator from one definition. Injecting third-party schemas at
  runtime would break the property that makes the runner auditable.
- **The model is small and local.** 5–60 tokens per second, 64k default
  context, and tool-call reliability that falls off with quantization and with
  the number of choices offered. Context spent on tool schemas is context not
  spent on the Confluence page.

These are not obstacles to route around. The constraint that forces the model's
tool surface to stay tiny is the same one that keeps credentials off the laptop.
Claude Code reached the same place from the other direction: since January 2026
its tool search defers MCP schema loading and cuts that context by 85–95%,
because unbounded tool surfaces were a bad idea even with a frontier model.

## The Architecture

```text
EMPLOYEE LAPTOP            |  COMPANY SERVER              |  SOURCES
                           |                              |
skills (SKILL.md, signed)  |  Veil                        |
                           |    |                         |
runner tool surface        |    | authorized call         |
  connector_search  -------|--> |                         |
  connector_call           |    v                         |
                           |  connector host  ------------|--> Jira
approval flow on writes    |    credential vault          |--> Confluence
                           |    per-user scope            |--> Bitbucket
no credentials, ever       |    egress allowlist          |--> Slack
                           |    audit log                 |
                           |       |                      |
                           |       | nightly ingest       |
                           |    RAG corpus (Qdrant)       |
```

The device sends an operation name and the enrolled user's identity. The
connector host holds every credential and calls the source as that user, so
Jira and Confluence ACLs apply without Umbratic reimplementing them. Results
come back tagged as untrusted data. Read-heavy sources take the ingest path
into the corpus Console already builds.

### 1. The bundle format

A directory with `umbratic-plugin.json`, a `skills/` folder in the format the
desktop already reads, and a `connectors/` folder of declarative connector
definitions: endpoint, auth method, operation allowlist, redaction rules,
required scopes. Ed25519-signed with the release key, verified by the desktop
and again by Console.

No executable code in a plugin, v1. That one rule deletes the supply-chain
problem the rest of the industry now has, and it costs little: the value is in
the skills and the operation allowlists, not in plugin-supplied code.

### 2. The catalog

`plugins/index.json` in the same R2 bucket, behind the same Worker, gated by
the same Veil-minted token. Sign the index; pin each bundle by SHA-256. Console
holds the org allowlist, so an administrator decides which plugins exist for
their company before any user sees one. Air-gapped customers import the same
signed bundle from a file through the existing zip-import path, which already
enforces entry counts and size caps.

### 3. The connector host

One Console-supervised process speaking MCP to connector servers. Reuse the
open-source ones — `mcp-atlassian` covers Jira and Confluence Data Center with
personal access tokens, and equivalents exist for Bitbucket, GitHub, and Slack
— rather than writing four API clients. MCP is the internal protocol between
Console and connectors. It is never exposed to the model and never reaches the
laptop, so the runner rule that every model request goes through an approved
Veil route stays intact.

### 4. The harness surface: two tools, not fifty

```text
connector_search(query)
  Find operations available on connected company systems.

connector_call(connector, operation, arguments)
  Run one operation. Writes require approval.
```

`arguments` is a bounded JSON object whose interior the runner does not
arbitrate. The catalog already has that precedent: the `artifact` tool's
`JsonObject { max_bytes }` field bounds size and holds no opinion about the
interior, because the engine downstream owns that schema. Connector arguments
are the same problem and deserve the same answer.

Each connector also ships a skill — `umbratic-jira`, `umbratic-confluence` —
costing about 100 tokens of catalog metadata until the model needs it, then
teaching it the workflow. That is Cursor's insight on a surface a 30B model can
hold in its head.

Local mode is the honest exception. A solo user with no company server has
nowhere to put a credential but the OS keychain, and the connector host becomes
an app-managed sidecar next to `llama-server`. That is the same posture as
every other harness. The credential-isolation claim is a server-mode claim and
should be stated that way.

## Knowledge Goes To The Corpus, Actions Go To The Connector

The instinct will be to make everything a live tool call. On a local model a
Confluence search returning six ranked, cited chunks costs a fraction of an
agentic search loop, and that pipeline is already written.

| Ask | Path | Why |
| --- | --- | --- |
| "What is our incident escalation policy?" | RAG corpus | Read-heavy, slow-changing, benefits from ranking. |
| "Summarize the last five tickets on PROJ" | `connector_call` | Live state; stale is wrong. Read-only, no approval. |
| "File a bug for what we just found" | `connector_call` and approval | Writes use the existing permission flow, as commands do. |
| "What did the team decide in #platform?" | RAG corpus | Slack history is a corpus, not an API to paginate. |

Permission fidelity is the expensive part. Ingesting a Confluence space into a
shared corpus flattens its ACLs unless they are carried through to query time;
Onyx made permission-syncing connectors an enterprise-tier feature for that
reason. Either carry source ACLs into the corpus as filter metadata and enforce
them at retrieval, or restrict v1 ingestion to spaces an administrator marks
company-readable. Do not ship the middle ground.

## Every Connector Is An Untrusted-Input Channel

In April 2026 researchers hijacked Claude Code, Gemini CLI, and GitHub Copilot
by putting instructions in pull-request titles, exfiltrating Actions secrets.
OWASP now carries MCP tool poisoning as a named attack. A Jira description is
the same class of channel: text an attacker can write that a model reads as
guidance.

Running the model locally does not fix this. It bounds the blast radius —
there is no vendor endpoint for the data to land at, and egress is allowlisted
per connector — but a poisoned ticket can still make the agent write the wrong
file. The controls that matter:

- Connector results enter the conversation as data with provenance — source,
  author, retrieval time — never merged into prompt text. Veil already refuses
  system-prompt overrides at every input shape; the same instinct applies.
- Tool descriptions from a connector are untrusted too. The signed operation
  allowlist is what makes the model see descriptions we signed rather than
  descriptions the server sent.
- A connector result never grants capability. No result unlocks a tool, widens
  a scope, or skips an approval.
- Per-connector egress allowlist on the host, per-user rate limits, and an
  audit row for every call — which is also the artifact a compliance buyer
  asks to see.

## Phases

| Phase | Work | New surface |
| --- | --- | --- |
| 0 | Sign the skill bundles we already ship, add `source` and `revision` to the catalog entries Veil already accepts, publish an index to R2 behind the existing Worker, add an org allowlist to Console. | None. No new tool, no protocol change, no Veil release. |
| 1 | Console pulls Confluence spaces and Jira project metadata on a schedule into the existing corpus. | None. Better answers through the RAG path that already exists. |
| 2 | `connector_search` and `connector_call` in the runner catalog, the Console-supervised connector host, a `connectors` feature name on `/api/health`, and four connectors: Jira, Confluence, Bitbucket or GitHub, Slack. Reads first, writes behind approval in the same release. | Two tools. Add a golden fixture for the new request fields, as the contract requires. |
| 3 | A signing path for customers' own bundles, Console as their private marketplace, and — only if executable plugin code becomes necessary — WASM against a versioned interface. | Never a plugin-spawned process on an employee's laptop. |

## Open Decisions

**Does the catalog version with the app, or independently?** Independently,
with each bundle declaring a compatibility floor (`minHarness`, and a required
Veil feature name). Pinning plugins to app versions makes a connector fix wait
for an installer, and it fights the wire-compatibility discipline already
committed to: a newer harness may talk to an older Veil and still succeed.

**Does the "not a public connector platform" line in `AGENTS.md` survive?**
Keep it, and mean it. What is proposed here is a governed connector platform:
curated, signed, administrator-allowlisted, no third-party code execution.
That is a different thing from an open marketplace, and the distinction is the
product. The sentence should be updated deliberately rather than quietly
outgrown.

**MCP internally?** Yes, but only behind Console. It buys the existing server
ecosystem and costs nothing at the harness boundary, because the model never
sees it.

**Who holds the connector credential?** Per-user OAuth where the source
supports it, held server-side and keyed to the enrolled identity; a service
account only as a fallback. A shared service account is easier and quietly
turns every employee into a superuser of the company's Jira, which is the
failure a security-conscious buyer is paying to avoid.
