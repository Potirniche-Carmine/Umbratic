---
tags: [tools, dap, lsp, mcp, browser-use, benchmarks, april-2026]
status: draft
---

# Agent Tooling — what to ship and what it buys you

For a self-hosted agentic coding stack like [[Sovereign_Coding_Agent]], the harness's *tools* are the actual product. The model is a substitute commodity (anyone can serve Qwen 3.6); the diff between a useful agent and a frustrating one is which tools it can call, how reliably it calls them, and how the harness packages the results back into context.

This article catalogs the tools that move the needle for an enterprise coding agent — with concrete benchmark numbers where they exist — and explains why each one is a *selling point* against a hosted competitor.

Backlinks: [[Index]], [[Sovereign_Coding_Agent]], [[Harness_Design_Principles]], [[Agent_Harnesses]], [[Codex_App]], [[Cursor]], [[Hermes]], [[Harness_Implementation_Plan]]

---

## The selling-point matrix

| Tool surface | Why it's a selling point | Typical accuracy lift over "shell only" | Status in the Sovereign Coding Agent |
|---|---|---|---|
| **Sandboxed shell** | Floor capability — without it, no agent | n/a (baseline) | ✅ §8.1 |
| **DAP debugger** | Runtime ground truth, not guesses; largest single accuracy lift on bug-fix tasks | +20–40 pts on bug-fix subtasks (anecdotal; see below) | ✅ §8.2 |
| **LSP** | Symbol/ref/diagnostics without tree-sitter hallucination | +5–15 pts on refactors | ⚠️ §8.1 (basic) |
| **Browser use** | Web UI testing, scraping internal dashboards, reading docs sites that don't expose APIs | n/a (orthogonal) | ❌ not in V1 |
| **MCP** | Universal tool bus; ecosystem of 17 K+ servers | varies | ❌ not in V1 (open question) |
| **Vector retrieval (RAG)** | Locate relevant code without grep-walk; preserves Manager budget | +10–20 pts on whole-repo tasks | ✅ §6, §7 |
| **Workspace `git` introspection** | Bug bisection, blame-driven hypothesis | n/a | ✅ §8.1 |
| **AST-aware chunking** | RAG quality floor; the difference between coherent retrieval and noise | +10 pts on retrieval recall | ✅ §7.4 |

Three of these are the differentiators against any cloud competitor: **DAP**, **browser use**, and **MCP**. The first is the largest accuracy lever; the second is the largest *capability* surface (suddenly the agent can do GUI work); the third is the cheapest way to plug a thousand third-party tools into the Sovereign Coding Agent's daemon.

---

## Sandboxed shell — the floor

Every harness has it; what separates good from bad is *where* the sandbox enforces.

| Layer | Examples | Verdict |
|---|---|---|
| Application-only | early Claude Code, naive harnesses | Trust-based; one bad rule and the agent escapes |
| **Kernel** | [[Codex_App#Sandboxing — the part that actually matters\|Codex Seatbelt/Landlock+seccomp]] | The bar to match |
| Container | OpenHands (Docker per session) | Strong; heavy |
| VM | Devin, GitHub Codespaces agents | Strongest; slow |

For v3 specifically: porting [[Codex_App|Codex's]] open-source `codex-linux-sandbox` helper (Landlock + seccomp) is roughly a week of work and converts §8.1's `shell.exec` from "we hope the agent obeys" to "kernel says no." On Mac, Seatbelt has the same shape; on Windows, restricted tokens are the available primitive. Hermes's seven-backend selector (local / Docker / SSH / Modal / Daytona / Singularity / Vercel — see [[Hermes#Tool-system depth]]) is overkill for a single-user agent but proves the abstraction.

**Selling point:** "the agent can't write outside the project root or open outbound connections, *enforced by the kernel*" beats "the agent has been told not to" every single time a customer security review happens.

---

## Debugger via DAP

The single most-leveraged underused tool in the 2026 harness ecosystem. [[Sovereign_Coding_Agent#8.2 Debugger Tool — DAP Integration|§8.2]] ships it; almost no other major harness does. This is *the* selling point.

### Why it's a step-change

For a class of bugs — *"my function returns the wrong value," "this test fails for a non-obvious reason," "intermittent failure"* — reading code is **not enough**. The agent needs the runtime values. Setting a breakpoint, running the failing path, and inspecting variables converts a research problem into a measurement problem. Empirically (anecdotal across [[Hermes]], [[Codex_App|Codex]], and academic agent papers), this is the largest single accuracy lift available on hard bug-fix subtasks.

There isn't a clean public benchmark that isolates "model + DAP" vs "model alone" yet — [[Coding_Benchmarks_2026#Open questions|the gap]] is acknowledged across the field. The closest evidence:

- **`mcp-debugger`** (the most-tested DAP-MCP bridge) reports **1,266+ tests passing** across Python, Node, Rust (CodeLLDB), Go (Delve), Java (JDI), and .NET (netcoredbg). Integration tests run *real* Claude Code and Codex sessions through the DAP surface across all those languages.
- **Microsoft DebugMCP** is the official VS Code DebugMCP server that exposes the editor's debugger to the agent — same pattern but VS Code-specific.
- **veh-debugger** is a Windows VEH-based debugger with DAP+MCP that explicitly targets Claude / Cursor / Codex / Windsurf as agent clients.
- **go-delve/mcp-dap-server** ships the DAP-MCP bridge for live Go programs.

The pattern: by April 2026 there are at least four production-quality MCP servers exposing DAP, all of them aiming at the same gap [[Sovereign_Coding_Agent#8.2 Debugger Tool — DAP Integration|§8.2]] fills natively. **The Sovereign Coding Agent's advantage is that the DAP surface is a *first-party* tool, not an MCP plugin** — that means session lifecycle, approval UX, and result compression go through the same daemon path as everything else, with no protocol bridging overhead.

### What "first-class DAP" buys over "DAP via MCP"

1. **Tighter approval UX.** [[Sovereign_Coding_Agent#8.2.5 Confirmation UX|§8.2.5]]'s "approve session start, all subsequent `debug.*` calls in the session are pre-approved" requires session-state knowledge the daemon already has. An MCP plug-in has to either prompt every call or rely on out-of-band session state.
2. **Result compression matches the rest of the system.** [[Sovereign_Coding_Agent#8.3 Tool result handling|§8.3]] routes any tool result >2 K tokens through the Worker for compression. With first-party DAP, `debug.scopes_and_variables` output is compressed under the same rule. Through MCP, the compression happens in the MCP server (or not at all) and the harness loses the contract.
3. **Auto-detected launch configurations.** [[Sovereign_Coding_Agent#8.2.4 Auto-detected launch configurations|§8.2.4]] picks the right launch config (`pytest <name>`, `cargo test`, `go test -run`, etc.) based on the user's task. An MCP plug-in has no idea what task the agent is working on.

### Languages covered (DAP adapter map)

| Language | Adapter | License | Notes |
|---|---|---|---|
| Python | `debugpy` | MIT | Conditional breakpoints can be slow — see [[Sovereign_Coding_Agent#15. Open Questions / Decisions to Validate|§15]] #1 |
| Node / Browser JS | `vscode-js-debug` | MIT | Bundled with VS Code |
| Rust / C / C++ | `codelldb` | MIT | LLDB-based; macOS/Linux solid, Windows quirky |
| Go | `delve` (`dlv dap`) | MIT | `dlv dap` is the DAP entry point |
| Java | JDI bridge / `java-debug` | EPL | Enterprise-friendly license |
| .NET / C# | `netcoredbg` | MIT | Microsoft-published |
| Ruby | `rdbg` | Ruby | Ships with modern Ruby |

For the Sovereign Coding Agent, this is "every language a developer at the customer might use, free, MIT-friendly except Java EPL." That's the quiet win: **one tool surface (`debug.*`), every language for free**.

### Selling-point pitch

> "When a test fails for a non-obvious reason, the agent doesn't guess. It sets a breakpoint at the line it suspects, runs the failing test, and reads the actual variable values. That's the difference between an agent that's right 60 % of the time and one that's right 85 % of the time on the bugs that actually matter."

---

## LSP — language server as a tool

Underexploited everywhere. Crush ([[Agent_Harnesses#Crush (Charmbracelet)]]) is the rare harness that treats LSP as first-class.

### What LSP gives the agent

- **`lsp.symbols`** — exact symbol list per file, no hallucination.
- **`lsp.refs`** — every callsite, with file:line precision.
- **`lsp.hover`** — inferred type, signature, docstring.
- **`lsp.diagnostics`** — compiler/linter errors *as data*, not parsed from stderr.
- **`lsp.definition`** — jump-to-definition, the same primitive the IDE uses.

These are deterministic, fast (LSP is in-process for each file), and they completely sidestep the *most common* hallucination class: "I'll call `get_user_by_id` because that sounds right" when the actual function is `users.find_one`.

### Why the Sovereign Coding Agent should expand §8.1's LSP entry

[[Sovereign_Coding_Agent#8.1 Tool surface|§8.1]] lists `lsp.symbols / lsp.refs / lsp.diagnostics / lsp.hover` already. What's missing:

- **`lsp.rename`** — atomic, multi-file rename. The agent does this *correctly* via LSP; doing it via `fs.write` is asking for partial-rename bugs.
- **`lsp.code_action`** — surface "auto-fix" / "extract function" / etc., the IDE-native quick-fix surface. Cheap, deterministic edits the agent can chain.
- **`lsp.format`** — guarantee output matches project formatter. Removes a class of "the agent's edit reverts on save" pathologies.

A Rust daemon already running `tokio` can spawn `rust-analyzer`, `pyright`, `typescript-language-server` etc. as child processes via the `lsp-types` and `tower-lsp-client` crates. LSP servers are *cheap*: ~50–200 MB resident, idle when not queried.

### Benchmark signal

There is no clean isolated-LSP benchmark, but [[Coding_Benchmarks_2026#BFCLv3|BFCLv3]] (function-calling reliability) is the proxy: a model that can construct a clean LSP call generally constructs clean tool calls in general. **IBM Granite 4.1 8B leads BFCLv3 in its size class** ([[Small_Models_2026#IBM Granite 4.0 H-Small (~32 B hybrid)]]) — directly relevant if the Sovereign Coding Agent swaps Qwen3-Coder-7B for Granite at the Worker tier.

---

## Browser use — the missing surface

Browser-use is the highest-leverage Sovereign Coding Agent *gap*. [[Sovereign_Coding_Agent#8.1 Tool surface|§8.1]] has `web.search` for internal docs, but nothing that lets the agent actually drive a browser to test a UI, read a non-API'd dashboard, or scrape a vendor's site.

### What it is

[Browser-Use](https://github.com/browser-use/browser-use) (81 K+ GitHub stars by March 2026, fastest-growing open-source AI project of 2025–26) is a Python library that turns any LLM into a full browser-driving agent. The model decides what to click, type, scroll, and when the task is done. Behind the scenes it cleans the DOM, strips irrelevant elements, labels interactive components, and surfaces a control interface to the LLM.

### Benchmark numbers (WebVoyager — 643 tasks across 15 sites)

| System | WebVoyager | Notes |
|---|---|---|
| **Surfer 2** (H Company) | **97.1 %** | 2026 SOTA |
| **Magnitude** | 93.9 % | |
| **AIME Browser-Use** | 92.34 % | |
| **Browserable** | 90.4 % | |
| **Browser Use** (open) | **89.1 %** | The reference open-source bar |
| **OpenAI Operator / CUA** | 87 % WebVoyager / **58.1 % WebArena** | OpenAI's own number |
| **Skyvern 2.0** | 85.85 % | |
| **Google Project Mariner** | 83.5 % | |

Two things to internalize:

1. **WebVoyager is largely solved** at 90 %+. The hard benchmark in 2026 is **WebArena** (real e-commerce / forum / mapping sites), where even OpenAI's CUA is at 58.1 %. WebArena is the better signal for "can my agent actually file an internal Jira ticket end-to-end."
2. **Browser-Use at 89.1 % is the open-source reference.** Adding it to the Sovereign Coding Agent is mostly a tool-surface decision; the model side already works. Browser-Use [explicitly supports Cursor and Claude Code as agent clients via Agents.md](https://github.com/browser-use/browser-use), and IDE integration is documented.

### What browser use enables for an enterprise coding agent

- **End-to-end UI verification.** "I made the change, here's the diff, here's a screenshot of the form actually working."
- **Reading non-APId internal dashboards.** Many enterprise tools (legacy admin portals, BI dashboards, compliance UIs) have no API. Browser-use lets the agent *read* them without the customer building an API.
- **Live preview-canvas** for frontend tasks ([[Gemma_Chat#Things to steal from Gemma Chat for the Sovereign Coding Agent|the same idea Gemma Chat ships]]).
- **Vendor docs** that are SPA-only or auth-walled. Lots of internal services fall in this bucket.

### How to ship it

Two integration shapes:

1. **Direct backend.** Add a `browser.*` tool surface to the Rust daemon. Headless Chromium via `chromiumoxide` (Rust-native) or spawn Browser-Use as a subprocess. The latter is faster to ship — tier-1 Browser-Use is Python.
2. **MCP server.** The community already wraps Browser-Use behind MCP. The Sovereign Coding Agent imports the MCP server as a registered tool; no Python in the daemon. Cleaner, slightly slower.

For the Sovereign Coding Agent, MCP is the right path because it's also how the [[Harness_Design_Principles#MCP — the universal tool bus|MCP gap closes]] in general — adopt MCP for browser use and inherit the rest of the registry for free.

### Sandboxing implications

A browser is the worst sandbox-escape vector in the toolset. Browser-Use needs:

- An ephemeral profile per session (no credentials carry).
- Network egress allowlist *per task*, not per agent.
- Screenshot redaction for telemetry (don't log "the agent loaded a Slack DM").
- A hard cap on outbound connections that survive a model going rogue.

This is the highest-effort tool to add safely. It's also the single most user-impressive capability — *"the agent opened the staging site, filed a ticket, and signed in"* is the demo that wins enterprise reviews.

### Selling-point pitch

> "Your agent doesn't just edit code — it opens the staging UI, runs the change, screenshots the result, and attaches it to the diff. End-to-end verification on every task, on premise."

---

## MCP — the universal tool bus

[[Harness_Design_Principles#MCP — the universal tool bus|This is the architecture's biggest open gap]]. By April 2026, MCP is the de facto standard for tool exposure: 17 K+ public servers, 97 M monthly SDK downloads, the 2026 roadmap pivoting to "production-ready" (transport scalability, agent-to-agent, governance, enterprise auth).

For the Sovereign Coding Agent:

- **Speak MCP natively, even if the internal protocol is typed JSON over WSS.** Expose an MCP-compatible facade. The ecosystem cost of *not* speaking MCP is large and growing.
- **Curate, don't reinvent the registry.** Ship a vetted subset of MCP servers per customer. The signal-to-noise on the public registry is collapsing.
- **OAuth 2.1 PKCE is the bar** ([[Hermes#Tool-system depth|see Hermes v0.4.0]]). Don't ship MCP without it.

### What MCP buys for the Sovereign Coding Agent specifically

| MCP server class | Why the architecture wants it |
|---|---|
| **Atlassian / Linear** | Read tickets the agent is supposed to fix |
| **GitHub / GitLab** | Read PR comments, file PRs back |
| **Sentry** | Read the actual stack trace the user is asking about |
| **Notion / Confluence** | Internal docs without re-indexing into the architecture's RAG |
| **Slack** | Send "your task is done, here's the diff" pings |
| **PagerDuty** | Read the on-call incident the agent is helping triage |
| **DAP** | Already covered by [[Sovereign_Coding_Agent#8.2 Debugger Tool — DAP Integration|§8.2]] natively, but external MCP DAP servers exist if needed |
| **Browser-Use** | The integration path discussed above |

The minimum credible MCP support: **be a client.** Be a server too if customers want their own tools to call the Sovereign Coding Agent — but that's V2.

---

## Vector retrieval — where the Sovereign Coding Agent already wins

[[Sovereign_Coding_Agent#7. Vector Database — Bundled, Invisible|§7]] is the most fully-specified part of the plan and one of the biggest defensive moats. Two things to highlight:

- **One LanceDB per project, on the laptop.** The single biggest cause of "RAG made it worse" is cross-project contamination. The Sovereign Coding Agent just doesn't do that.
- **AST-aware chunking via tree-sitter (cAST).** Function/class boundaries instead of fixed-size chunks. Empirically lifts retrieval recall by 10+ points on code-heavy queries — see the [cAST paper](https://arxiv.org/html/2506.15655v1).

The competitor to track here is **[Cursor's Codebase Chat](Cursor.md)** — same problem, cloud-hosted index, weekly index churn paid by Anysphere. The Sovereign Coding Agent's local-first stance saves the customer that operational cost while solving the same retrieval problem.

---

## Putting it all together — the "selling point" pitch

A Sovereign Coding Agent demo lands on these three lines:

1. **"Your code never leaves the network."** Self-hosted Qwen 3.6-27B on a perimeter GPU; per-project LanceDB on the laptop; mTLS edge gateway. ([[Sovereign_Coding_Agent#11. Security & Privacy]])
2. **"The agent can run a debugger."** First-class DAP across Python, Node, Rust, Go, Java, .NET — set breakpoints, step, inspect runtime variables. ([[Sovereign_Coding_Agent#8.2 Debugger Tool — DAP Integration]])
3. **"It improves on your team's review patterns."** Every accepted hunk, rejected hunk, manual edit, and inline comment becomes preference data. Quarterly DPO LoRA on Qwen plus (recommended addition from [[Hermes#The self-evolution loop]]) weekly GEPA prompt evolution.

If browser use is added, that's the fourth line — and arguably the most demo-friendly.

---

## What the Sovereign Coding Agent needs to add to close the gap

| Gap | Add | Where |
|---|---|---|
| Kernel-layer sandbox | Port Codex's Landlock+seccomp helper | [[Codex_App#What the Sovereign Coding Agent should steal from Codex\|Codex_App]] |
| MCP client | Implement MCP transport in Rust daemon | [[Harness_Design_Principles#MCP — the universal tool bus]] |
| Browser use | MCP-bridge Browser-Use; sandbox per-session | this article |
| LSP rename / code-action / format | Expose more of the LSP surface as tools | this article |
| GEPA prompt evolution | Run weekly on telemetry traces | [[Hermes#What the Sovereign Coding Agent should steal from Hermes]] |
| Worktree-per-session | Match Codex's pattern for parallel agents | [[Codex_App#What the Sovereign Coding Agent should steal from Codex]] |

None of these break the architecture. They're additive — and together they close every named gap between the Sovereign Coding Agent and the most capable harnesses shipping in April 2026.

---

## Sources

### DAP / debugger MCP
- [Debug Adapter Protocol — Microsoft spec](https://microsoft.github.io/debug-adapter-protocol/specification.html)
- [mcp-debugger (debugmcp)](https://github.com/debugmcp/mcp-debugger)
- [Microsoft DebugMCP](https://github.com/microsoft/DebugMCP)
- [Govinda Fichtner DAP MCP Server (Rust)](https://github.com/Govinda-Fichtner/debugger-mcp)
- [VEH Debugger (Windows VEH+DAP+MCP)](https://github.com/knewstimek/veh-debugger)
- [go-delve/mcp-dap-server](https://github.com/go-delve/mcp-dap-server)
- [DAP MCP Server — Kashun Cheng (PulseMCP)](https://www.pulsemcp.com/servers/kashuncheng-dap)
- [AI Debugger MCP — ai-debugger.com](https://ai-debugger.com/en/latest/)

### Browser use
- [Browser-Use on GitHub (81 K+ stars)](https://github.com/browser-use/browser-use)
- [Browser Use SOTA Technical Report](https://browser-use.com/posts/sota-technical-report)
- [Stagehand vs Browser Use vs Playwright — NxCode](https://www.nxcode.io/resources/news/stagehand-vs-browser-use-vs-playwright-ai-browser-automation-2026)
- [Playwright CLI vs agent-browser vs Claude in Chrome — ytyng](https://www.ytyng.com/en/blog/ai-browser-automation-tools-comparison-2026)
- [11 Best AI Browser Agents in 2026 — Firecrawl](https://www.firecrawl.dev/blog/best-browser-agents)
- [WebVoyager benchmark](https://github.com/MinorJerry/WebVoyager)
- [WebArena benchmark](https://github.com/web-arena-x/webarena)
- [AI Browser Agent Leaderboard — Steel.dev](https://leaderboard.steel.dev/)
- [Magnitude SOTA WebVoyager](https://github.com/sagekit/webvoyager)
- [Best Web Agents: Computer Use vs Operator vs Browser Use — Helicone](https://www.helicone.ai/blog/browser-use-vs-computer-use-vs-operator)

### Sandboxing
- [Codex sandboxing implementation — DeepWiki](https://deepwiki.com/openai/codex/5.6-sandboxing-implementation)
- [A deep dive on agent sandboxes — Pierce Freeman](https://pierce.dev/notes/a-deep-dive-on-agent-sandboxes)
- [Research: OpenAI Codex CLI Sandbox — Simon Willison](https://simonwillison.net/2025/Dec/24/codex-sandbox-investigation/)

### LSP & retrieval
- [cAST: AST-Structural Code Chunking — arXiv 2506.15655](https://arxiv.org/html/2506.15655v1)
- [BFCLv3 leaderboard — UC Berkeley](https://gorilla.cs.berkeley.edu/leaderboard.html)

### MCP
- [The 2026 MCP Roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [MCP Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Adoption Statistics 2026 — MCP Manager](https://mcpmanager.ai/blog/mcp-adoption-statistics/)
- [MCP-Bench — Accenture (benchmarking tool-using LLM agents via MCP)](https://github.com/Accenture/mcp-bench)
