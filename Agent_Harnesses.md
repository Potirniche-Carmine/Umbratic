---
tags: [agent, harness, cli, ide, comparison, april-2026]
status: draft
---

# Agent Harnesses — April 2026 Landscape

A **harness** is everything in an AI coding agent except the model itself: the loop, tool calls, context manager, sandbox, permission system, memory, observability. The phrase has crystallized in 2026 — see Martin Fowler's "Harness Engineering" piece and Anthropic's framing of "Agent = Model + Harness."

This article surveys the harnesses an engineer can pick up today, with pros/cons. Design principles that cut across all of them live in [[Harness_Design_Principles]].

Backlinks: [[Index]], [[Sovereign_Coding_Agent]], [[Warp]], [[Gemma_Chat]], [[Codex_App]], [[Cursor]], [[Hermes]], [[Harness_Design_Principles]], [[Small_Models_2026]], [[Tooling_Benefits]], [[Harness_Implementation_Plan]]

---

## Categorization

| Category | Examples | Distinguishing trait |
|---|---|---|
| **Vendor-bound terminal agent** | Claude Code, OpenAI Codex CLI, Gemini CLI, Amazon Q | Tied to one provider; deepest model integration |
| **BYO-LLM CLI** | Aider, Goose, Plandex, gptme, Crush, OpenCode | Bring any model (cloud or local); user controls cost |
| **IDE-extension agent** | Cline, Roo Code, Continue.dev | Lives inside VS Code; visual diff review |
| **Full agent platform** | OpenHands, SWE-Agent, Devin | Cloud-deployable, multi-session, often issue-tracker integrated |
| **Terminal-as-product** | Warp ([[Warp]]) | Replaces the shell; agent hosts other agents |
| **Local-only desktop** | Gemma Chat ([[Gemma_Chat]]), LM Studio agents | All-on-device, no network round-trip |
| **Universal wrapper** | pi-builder, OpenRouter Agents | Routes between underlying harnesses behind one interface |

---

## Vendor-bound terminal agents

### Claude Code (Anthropic)

The most fully-featured agentic runtime as of April 2026.

**Pros**
- **CLAUDE.md** as a per-project instruction file that persists every session — the most leveraged single feature.
- **26 programmable hook events** for fine-grained safety/observability at the application layer.
- **Computer use** since March 2026 — point-and-click through UIs, screenshots, automating untestable workflows.
- **Sub-agents** as first-class — context isolation, ~67 % token savings on multi-domain tasks.
- Rich MCP integration; ships its own SDK for building agents.
- **Anthropic Managed Agents** (public beta 2026-04-08) — hosted harness loop + tools + sandbox + state, billed per-token plus session-hour.

**Cons**
- **Vendor lock-in**: Anthropic models only. No BYO-LLM.
- Per-token cost is the cost — no path to local Qwen for cost-sensitive workloads.
- Hooks and sub-agents are powerful but the configuration surface is large; teams over-configure.

**When to pick:** complex feature work, high code-quality bar, willingness to pay frontier-model rates.

### OpenAI Codex CLI

OpenAI's terminal agent. Different design center than Claude Code.

**Pros**
- **OS-kernel-layer sandboxing** (Seatbelt on macOS, Landlock + seccomp on Linux) — coarser but stronger blast-radius guarantees than Claude Code's app-level hooks.
- Pairs directly with **GPT-5.4-Codex** which leads SWE-bench Pro at **56.8 %** in April 2026.
- Aggressive autonomy defaults: strong fit for infrastructure / DevOps / "just do it" tasks.

**Cons**
- Less of an *orchestrator*: thinner sub-agent model than Claude Code.
- Vendor-bound to OpenAI.
- Documentation lags Claude Code.

**When to pick:** infrastructure, DevOps, CI/CD glue, throughput-shaped work where speed > nuance.

### Gemini CLI

Google's terminal agent. Notable for being free at high token rates and having Gemini's massive context window.

**Pros**
- **2 M token context** (Gemini 3.x).
- Free / generous quota tier as of April 2026.
- Tight integration with Google Cloud / Vertex AI.

**Cons**
- Tool-calling reliability still trails Claude / GPT-5.
- Less agentic-mature ecosystem; fewer pre-built MCP servers.

---

## BYO-LLM CLIs

### Aider

The original. Apache 2.0, ~41 K stars. Proved the "terminal pair-programmer" pattern.

**Pros**
- **Architect/Editor split** — a strong reasoning model plans; a fast cheap model translates the plan into edits. Hits SOTA on Aider Polyglot.
- Supports nearly every LLM: Claude, GPT, DeepSeek, **local via Ollama / vLLM**.
- First-class git integration: commits per change with auto-generated messages, reverts via git.
- **Aider Polyglot benchmark** (225 hard Exercism problems across C++, Go, Java, JS, Python, Rust) is one of the most cited code-edit benchmarks.

**Cons**
- Single-file editing model — less of a *whole-repo agentic* tool. Stronger on focused changes than autonomous multi-step tasks.
- TUI is utilitarian; no rich diff review surface.
- No native sub-agent / parallel agents concept.

**When to pick:** working in your own repo, want full control over which model, want git-clean change history.

### Goose (Block, Apache 2.0, ~32 K stars)

Native open-source agent: desktop app + CLI + API.

**Pros**
- **Native MCP** — Goose was an early adopter, large catalog of "Recipes."
- Apache 2.0; backed by Block (Cash App / Square).
- Local-friendly; runs against Ollama out of the box.
- Cleanly cross-platform (Mac/Linux/Win).

**Cons**
- Less momentum than Cline/Aider on raw star counts.
- Coding-specific tuning lags Aider's Architect/Editor split.

**When to pick:** want a polished open-source desktop agent with the MCP ecosystem and BYO-LLM, without a VS Code dependency.

### Plandex

Plan-first agent: builds a long, mutable plan and edits against it.

**Pros**
- Strong long-horizon task structure: explicit plan tree with resumable branches.
- Self-hosted server option for team use.

**Cons**
- Smaller community.
- Editor/diff UX is plain.

### Crush (Charmbracelet)

Glamorous agentic coding TUI in Go. Multi-provider, LSP-aware.

**Pros**
- Best-in-class TUI ergonomics.
- LSP integration as a first-class tool — symbolic understanding without full code-graph indexing.

**Cons**
- Younger, smaller ecosystem.
- TUI-only — no IDE bridge.

### gptme / OpenCode / others

Long tail of single-author CLIs. Useful for specific niches; harder to recommend as a primary tool.

---

## IDE-extension agents

### Cline (Apache 2.0, ~58 K stars)

The pioneer of the VS Code agent extension category.

**Pros**
- **Step-by-step approval** — best-in-class human-in-the-loop control.
- Audit trail for every action; ideal for regulated environments.
- BYO-LLM (Anthropic, OpenAI, OpenRouter, local).
- Single mode → simple mental model.

**Cons**
- Single-mode means less structured behavior than Roo Code's specialized modes.
- Approval friction can dominate on long autonomous runs.

### Roo Code (Apache 2.0, ~22 K stars; Cline fork)

Multi-mode evolution of Cline.

**Pros**
- **Architect / Code / Debug / Custom** modes — structured behavior for different task types. Custom modes let teams encode workflows.
- Inherits Cline's approval system.
- More configurable than Cline at the cost of more setup.

**Cons**
- Mode proliferation can become bureaucratic.
- Smaller community than parent Cline.

### Continue.dev (Apache 2.0, ~31 K stars)

VS Code + JetBrains autocomplete + chat with strong privacy/local focus.

**Pros**
- **Cross-IDE** — same agent inside VS Code, JetBrains, etc.
- Local-first defaults; integrates well with Ollama.
- Mature autocomplete in addition to chat/agent.

**Cons**
- Less aggressively agentic than Cline / Roo Code — feels like "Copilot but BYO-LLM" more than a full agent.
- Tool-calling depth trails the dedicated agent tools.

---

## Full agent platforms

### OpenHands (MIT, ~68 K stars — biggest open agent platform by stars)

Formerly OpenDevin. The reference open-source equivalent of Devin.

**Pros**
- **Sandboxed Docker container per session** — strong isolation by default.
- **Solves >50 % of real GitHub issues** on its own benchmarks.
- SDK for building custom agents — first-class extension surface.
- MIT licensed, $18.8 M Series A → real ongoing investment.
- The de facto scaffold for Devstral and other "agent-tuned" small models.

**Cons**
- Heavyweight to deploy compared to a CLI; the Docker dependency is non-trivial in restricted environments.
- Browser-first UI; less terminal-native than Aider / Goose.
- Tighter vendor opinion on which scaffold is "correct" — less flexible for novel agent loops.

**When to pick:** team-scale deployments where you want a hosted, multi-session agent platform with strong sandboxing.

### SWE-Agent

Princeton's research scaffold; the default benchmark scaffold for SWE-bench papers.

**Pros**
- Most-cited scaffold for SWE-bench-shaped evals — reproducibility.
- Minimal, readable, easy to extend.

**Cons**
- A *research* scaffold, not a daily-driver tool. Production polish is missing.

### Devin (Cognition, closed)

Closed-source autonomous agent service. Out of scope for open-source choices but worth noting as the marketing benchmark competitors aim at.

---

## Hybrid / wrapper

### pi-builder

Universal wrapper that fronts any installed CLI agent (Claude Code, Aider, OpenCode, Codex, Gemini CLI, Goose, Plandex, SWE-agent, Crush, gptme).

**Pros**
- **Capability-based routing** with health caching and fallback chains.
- Streaming OrchestratorService — single interface to many backends.
- SQLite persistence; survives restarts.

**Cons**
- An abstraction over abstractions — debugging which path failed gets fiddly.
- Locks you into yet another tool's lifecycle.

**When to pick:** running benchmarks across multiple agents, or hedging vendor risk.

---

## How they compare on the things that matter

| Criterion | Best in class |
|---|---|
| **Raw SWE-bench V (single agent + frontier model)** | Claude Code + Opus 4.7 (87.6 % via Opus alone), GPT-5.4 + Codex CLI |
| **Open-source agent + open-weight model** | OpenHands + Devstral (or Qwen 3.6-27B); Aider Architect + Qwen 3.6-27B + Qwen3-Coder-7B |
| **Approval / audit** | Cline |
| **Sandboxing** | Codex CLI (kernel-layer), OpenHands (Docker) |
| **Sub-agents / parallel context** | Claude Code |
| **TUI ergonomics** | Crush |
| **MCP ecosystem** | Claude Code, Goose |
| **Local-only / privacy** | Aider + Ollama, Continue.dev, Gemma Chat ([[Gemma_Chat]]) |
| **Long-context** | Gemini CLI (2 M), Llama 4 + Codex (10 M) |
| **Whole-repo autonomous** | OpenHands, Devin |
| **Polyglot file edits** | Aider (Architect/Editor) |

---

## Implications for the Sovereign Coding Agent

*Maps onto [[Sovereign_Coding_Agent]].*

The Sovereign Coding Agent design **does not pick an existing harness** — it builds its own (Rust daemon + Electron UI + DAP debugger + LanceDB + DPO loop). That's defensible: no existing harness today combines all four of the architecture's commitments (DAP, project-vector DB, DPO on review signal, Manager-Worker intra-model split). But four open observations:

1. **The CLAUDE.md pattern is generalizable.** The architecture's L2 (Project Card) is conceptually the same thing — auto-generated rather than hand-written. Worth letting teams *override* the auto-generated card with a hand-written file at the project root.
2. **Cline's step-by-step approval is the right baseline.** The architecture's tool-confirmation UX should default *closer* to Cline (approve every shell command) than to OpenHands (sandbox-and-go), because the UX target is review-loop trust-building, not autonomous throughput.
3. **OpenHands as a worker.** A future revision could host OpenHands (or Codex CLI) as a *worker* behind the review loop, the way [[Warp]] hosts external CLIs. The shell sandbox tool (§8 of [[Sovereign_Coding_Agent]]) is most of the way there.
4. **Aider's Architect/Editor split applies to Manager-Worker.** The architecture's Manager already plays the Architect role; the **Editor** role (the cheaper model that converts a plan into precise edits) is currently fused with Manager output. Splitting the *file-edit step* off to Qwen3-Coder-7B (the Worker) explicitly — Manager produces a structured plan, Worker emits the patches — is a worthwhile experiment.

---

## Open questions

- Do **Claude Code's hooks** map cleanly onto the Sovereign Coding Agent's tool protocol? If so, the architecture could adopt the hook surface verbatim and inherit the Anthropic ecosystem of pre-built hooks.
- Can **OpenHands run as a Sovereign Coding Agent sub-agent** (sandbox container worker behind the review surface)? The license (MIT) allows this; the integration cost is mostly protocol bridging.
- **MCP server adoption inside the Sovereign Coding Agent** — every harness in 2026 speaks MCP; the architecture should too. Does its typed-JSON tool protocol (§4.3) need to expose an MCP-compatible facade?
- **Bake-off**: Aider Architect/Editor (Qwen 3.6-27B + Qwen3-Coder-7B) vs the Sovereign Coding Agent's Manager-Worker on its canonical eval set. Same models, different harness — is the harness work pulling its weight?

---

## Sources

- [Awesome CLI Coding Agents — bradAGI](https://github.com/bradAGI/awesome-cli-coding-agents)
- [The Anatomy of an Agent Harness — LangChain](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)
- [Harness engineering for coding agent users — Martin Fowler](https://martinfowler.com/articles/harness-engineering.html)
- [Skill Issue: Harness Engineering for Coding Agents — HumanLayer](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [Claude Code vs Codex CLI vs Aider vs OpenCode — Jock Pl](https://thoughts.jock.pl/p/ai-coding-harness-agents-2026)
- [Inside the Agent Harness — Jonathan Fulton (Medium)](https://medium.com/jonathans-musings/inside-the-agent-harness-how-codex-and-claude-code-actually-work-63593e26c176)
- [Codex vs Claude Code 2026 — MindStudio](https://www.mindstudio.ai/blog/codex-vs-claude-code-2026)
- [Best Open-Source AI Coding Tools 2026 — Frontman](https://frontman.sh/blog/best-open-source-ai-coding-tools-2026/)
- [Open-Source AI Coding Agents 2026 — WeTheFlywheel](https://wetheflywheel.com/en/guides/open-source-ai-coding-agents-2026/)
- [Top 8 Open-Source Coding Agents 2026 — OS AI Review](https://www.opensourceaireview.com/blog/top-8-open-source-coding-agents-in-2026)
- [Roo Code vs Cline 2026 — Qodo](https://www.qodo.ai/blog/roo-code-vs-cline/)
- [Cline](https://cline.bot/)
- [OpenHands](https://openhands.dev/)
- [Goose (Block) Open Source announcement](https://block.xyz/inside/block-open-source-introduces-codename-goose)
- [Aider Polyglot Benchmark](https://aider.chat/docs/leaderboards/)
- [The 2026 Guide to Coding CLI Tools — Tembo](https://www.tembo.io/blog/coding-cli-tools-comparison)
