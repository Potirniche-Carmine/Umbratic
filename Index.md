---
tags: [index, overview, agentic-coding, april-2026]
status: living
last_updated: 2026-04-29
---

# AI Project — Index

This topic tracks **agentic coding assistants**: how they're architected, how they integrate with editors and terminals, what model runtimes they use, and what trade-offs the surrounding **harnesses** and **small open-weight models** force as of April 2026.

The seed article is the user's own design doc for an internal Qwen-3.6-based agent. Adjacent articles cover comparable shipping systems, the small-model landscape they could plausibly draw from, the cross-cutting harness-engineering principles they all wrestle with, and — added 2026-04-29 — the **implementation plan** for actually building the v3 product as a Rust + Electron app, plus deep dives on tooling, packaging, and the two harnesses (Codex, Cursor, Hermes) most relevant as references.

## Articles

### Seed — the Sovereign Coding Agent product

- [[Sovereign_Coding_Agent]] — internal design doc. Manager-Worker (Qwen 3.6-27B + Qwen3-Coder-7B), Electron + Rust, project-scoped LanceDB, DAP debugger, all-local code path.
- [[Harness_Implementation_Plan]] — concrete build plan for the Sovereign Coding Agent: Rust crate map, Electron client split, sandbox layer, DAP module, two-loop self-improvement, 30-week phased rollout, packaging and component placement.
- [[LLM_Packaging]] — what runs on the GPU server (vLLM, Envoy AI Gateway, Postgres, Qdrant), how the laptop connects through a corporate VPN with mTLS, and how to run the entire stack locally with a 7B model for trials and degraded-mode fallback.
- [[Tooling_Benefits]] — the agent's tool surface as the actual product: kernel sandbox, DAP debugger, LSP, MCP, vector retrieval, browser-use. With benchmarks where they exist.

### Reference systems

- [[Codex_App]] — OpenAI's CLI/IDE/desktop family. **Rust core** (`codex-rs`, ~70 crates), **Electron desktop app**, **kernel-layer sandboxing** (Seatbelt / Landlock+seccomp / Windows ACLs). The closest *architectural* template for the Sovereign Coding Agent.
- [[Cursor]] — Anysphere's VS Code-fork agent IDE. **Composer 2** model (Kimi K2.5 base, 1T/32B-active MoE, MXFP8 + RL), Priompt for context budgeting, speculative-edits trick, Background Agents in cloud VMs.
- [[Hermes]] — Nous Research's **self-evolving** agent stack (MIT). The only mainstream harness with an explicit GEPA + DSPy improvement loop on prompts/skills/code, no GPU training. ACP editor adapter, 7-backend execution selector, MCP with OAuth 2.1 PKCE.
- [[Warp]] — Rust-based agentic terminal/IDE from warp.dev. Ships an "Oz" agent and orchestrates external CLI agents (Claude Code, Codex, Gemini CLI). Issues-only public repo + dual MIT/AGPL licensing.
- [[Gemma_Chat]] — local-only Electron coding agent for Apple Silicon. MLX-LM runtime, Gemma 4 family, XML `<action>` agent loop with a 40-round cap, sandboxed workspace.

### Landscape & reference

- [[Small_Models_2026]] — pros/cons of every ≤30B open-weight model relevant to a single-GPU agentic stack: Qwen 3.6-27B, Gemma 4, Mistral Small / Devstral, DeepSeek-R1-Distill, Phi-4-reasoning, EXAONE 4, IBM Granite 4, Qwen3-Coder, Hermes 4. *Default Manager pick: Qwen 3.6-27B.*
- [[Agent_Harnesses]] — the 2026 harness landscape. Vendor-bound (Claude Code, Codex CLI, Gemini CLI), BYO-LLM CLIs (Aider, Goose, Plandex, Crush), IDE extensions (Cline, Roo Code, Continue), full platforms (OpenHands, SWE-Agent), with pros/cons each.
- [[Harness_Design_Principles]] — what makes one harness better than another: the four pillars (system prompt, tools, context, sub-agents) plus sandboxing, observability, evals, MCP, permission models, memory.
- [[Coding_Benchmarks_2026]] — reference card for SWE-bench Verified / Pro, Terminal-Bench 2.0, Aider Polyglot, LiveCodeBench v6, Codeforces ELO, BFCLv3. What each measures and how to read the numbers.

## Cross-cutting threads

| Thread | Articles |
|---|---|
| Local-first / "code never leaves the machine" | [[Sovereign_Coding_Agent]], [[Gemma_Chat]], [[Small_Models_2026]], [[LLM_Packaging]] |
| Electron + Rust UI shells for AI dev tools | [[Sovereign_Coding_Agent]], [[Codex_App]], [[Warp]], [[Harness_Implementation_Plan]] |
| Multi-agent orchestration | [[Sovereign_Coding_Agent]] (Manager-Worker), [[Warp]] (Oz + external CLIs), [[Cursor]] (Background Agents, /multitask), [[Hermes]] (platform-agnostic core), [[Harness_Design_Principles]] (sub-agents) |
| Tool-calling loops with bounded iteration | [[Sovereign_Coding_Agent]] (DAP + shell + LSP), [[Gemma_Chat]] (40-round XML action loop), [[Hermes]] (61 tools / 52 toolsets), [[Tooling_Benefits]] |
| Apple Silicon / MLX as deployment target | [[Gemma_Chat]], [[Small_Models_2026]] (Gemma 4 small variants, Phi-4), [[LLM_Packaging]] (local trial path) |
| Open-weight models ≤30B, April 2026 | [[Small_Models_2026]], [[Coding_Benchmarks_2026]] |
| Context engineering & sub-agents | [[Harness_Design_Principles]], [[Sovereign_Coding_Agent]] §6, [[Cursor]] (Priompt), [[Harness_Implementation_Plan#2.4 Context assembly with Priompt-style priorities]] |
| Sandboxing & permission UX | [[Harness_Design_Principles]], [[Codex_App]] (kernel-layer), [[Tooling_Benefits#Sandboxed shell — the floor]], [[Hermes]] (7 execution backends) |
| MCP / universal tool bus | [[Harness_Design_Principles]], [[Agent_Harnesses]], [[Tooling_Benefits#MCP — the universal tool bus]], [[Hermes]] (OAuth 2.1 PKCE) |
| Self-improvement loops | [[Sovereign_Coding_Agent]] §12 (DPO), [[Cursor]] (real-time RL on Composer), [[Hermes]] (GEPA), [[Harness_Implementation_Plan#5. Self-improvement — the two-loop pattern]] |
| Benchmarks (SWE-bench, Terminal-Bench, Aider Polyglot, BFCLv3) | [[Coding_Benchmarks_2026]], [[Small_Models_2026]], [[Tooling_Benefits]] |
| Server packaging (vLLM, Envoy, Postgres) | [[LLM_Packaging]], [[Sovereign_Coding_Agent]] §5 |
| VPN / corporate network connectivity | [[LLM_Packaging#The link — connecting laptop to server through a corporate network]], [[Harness_Implementation_Plan#4. The link — VPN + WSS + mTLS]] |
| Self-improving agent (DPO + GEPA) | [[Hermes]], [[Sovereign_Coding_Agent]] §12, [[Harness_Implementation_Plan#5. Self-improvement — the two-loop pattern]] |

## Resolved questions (answers in linked notes)

The questions below opened in earlier drafts and have answers — even if partial — after the 2026-04-29 round of research.

- **Should the Sovereign Coding Agent expose an MCP-compatible facade in front of its typed-JSON tool protocol?** Yes. The 2026 ecosystem cost of *not* speaking MCP is large. The architecture should be an MCP **client** in V1 (consume servers), and an MCP **server** in V2 (expose its tools to other agents). OAuth 2.1 PKCE is the auth bar — see [[Tooling_Benefits#MCP — the universal tool bus]] and [[Hermes#Tool-system depth]].
- **A/B Granite 4.1 8B vs Qwen3-Coder-7B in the Worker slot.** Recommendation: bake-off in [[Harness_Implementation_Plan#7. Build order|Phase 2]]. Granite 4.1 8B leads BFCLv3 in the 8B class and matches the prior 32B-A9B Granite MoE on tool calling — it's the favored pick for *brief quality*. Qwen3-Coder-7B wins on *Manager tokenizer alignment* and on speed. Pick by measured brief-fidelity and Worker-call latency, not by reputation. See [[Small_Models_2026#Implications for the Sovereign Coding Agent]].
- **Aider Architect/Editor split applied to Manager-Worker.** Worth a Phase 5–6 A/B once review-loop data accumulates. Mechanics in [[Agent_Harnesses#Implications for the Sovereign Coding Agent]] and [[Harness_Implementation_Plan#8. Open questions that block / unblock]].
- **What does Codex's desktop app actually use?** Electron, with the same `codex-app-server` JSON-RPC interface as the IDE extension. Mac is mature; Windows lags because of weaker OS-level sandbox primitives. See [[Codex_App#The Codex desktop app — Electron, specifically]].
- **What's Cursor's training stack and Composer architecture?** Composer 2 is built on Kimi K2.5 (1T params, 32B active MoE), trained with continued pretraining + RL on real engineering tasks, served at MXFP8 with MTP heads for 2–3× speculative decoding. See [[Cursor#Composer — Cursor's in-house model]] and the [Composer 2 Technical Report PDF](https://cursor.com/resources/Composer2.pdf).
- **What's the agent-tooling selling point for the Sovereign Coding Agent vs cloud competitors?** Three lines: (1) "code never leaves the network," (2) **kernel-sandboxed tool calling** + **first-class DAP debugger**, (3) self-improving via DPO LoRA quarterly *plus* GEPA prompt-evolution weekly. See [[Tooling_Benefits#Putting it all together — the "selling point" pitch]] and [[Harness_Implementation_Plan#6. The selling-point pitch — what the demo says]].
- **Local 7B-model trial — what does it look like?** Ollama serving Qwen3-Coder-7B on `localhost:11434`, daemon points at it as if it were the orchestrator, full Electron UI works end-to-end. Same path doubles as the production "VPN-down fallback." See [[LLM_Packaging#The local 7 B trial — single-laptop POC]].
- **VPN / corporate-network shape for the laptop↔server link.** WSS + mTLS over the customer's existing corporate VPN (or Tailscale / Headscale for smaller teams). gRPC and HTTP/2 streaming were rejected because TLS-inspecting middleboxes mangle them. See [[LLM_Packaging#The link — connecting laptop to server through a corporate network]].
- **Does GEPA-style self-evolution apply to the Sovereign Coding Agent?** Yes — strictly additive on top of [[Sovereign_Coding_Agent#12. Feedback Loop & Continuous Improvement|§12]]'s DPO loop. GEPA is the **fast** loop ($2–10/run, weekly, evolves prompts/tool-descriptions); DPO is the **slow** loop (GPU-days, quarterly, evolves model weights). See [[Hermes#The self-evolution loop]] and [[Harness_Implementation_Plan#5. Self-improvement — the two-loop pattern]].
- **What's the right benchmark for browser-use as a Sovereign Coding Agent capability?** WebVoyager is largely solved (Browser-Use itself at 89.1 %). The harder benchmark is WebArena (real e-commerce / forum / mapping sites), where even OpenAI's Computer-Using Agent is at 58.1 %. See [[Tooling_Benefits#Browser use — the missing surface]].

## Still-open questions

### Sovereign-Coding-Agent-specific

- How does Warp's Oz agent handle context budgeting compared to the Manager-Worker split in [[Sovereign_Coding_Agent]]? *No public detail; would need a teardown.*
- Does [[Gemma_Chat]]'s XML `<action>` parser have a meaningful failure mode the Sovereign Coding Agent's tool protocol should defend against? *Likely yes — JSON tool calls are still the right V1 pick — but quantification needs a controlled test on malformed model output.*
- Where do Warp's "spec writing → implementation → PR review" stages sit relative to the Sovereign Coding Agent's review loop? *Open.*

### Landscape-tracking

- Is there a **Qwen 3.6-8B / 14B dense** release coming? Would change the Worker calculus.
- **Devstral generalization** — does its scaffold-tuning advantage transfer outside OpenHands?
- **MCP "verified" tier** — with 17 K+ servers in the registry, what does a curated/audited subset look like? *Hermes's OAuth 2.1 PKCE is the cleanest auth example so far; "verified" is the next step.*

### Harness research

- **Single best benchmark for review-loop UX** — current public benchmarks don't measure revise quality after user feedback. *Hermes's YC-Bench is the closest long-horizon signal but isn't review-loop-specific. See [[Hermes#Benchmarks Hermes uses]] and [[Coding_Benchmarks_2026#Open questions]].*
- **Sub-agent budgeting** — how many to spawn, by what heuristic? No published theory. *Candidate experiment: GEPA-evolve the spawn heuristic on Cursor-style /multitask traces.*
- **Context compression quality** — Worker briefs are lossy by design; quantifying that loss vs ground truth is an open methodology gap.
- **Permission UX vs autonomy** — Cline's audit trail vs OpenHands' sandbox-and-go is a Pareto frontier with no published user-satisfaction curve.
