---
tags: [implementation, plan, rust, electron, harness, packaging, deployment, april-2026]
status: draft
last_updated: 2026-04-30
---

# Harness Implementation Plan — building the Sovereign Coding Agent

> Concrete plan for shipping the [[Sovereign_Coding_Agent]] design as a real product: a **Rust agent daemon** + **Electron client** that connects to a self-hosted **Qwen 3.6 + Qwen3-Coder** model server through a **VPN + WSS-with-mTLS** link. The design doc says *what* to build; this plan says *how* to build it, *where each piece lives* once it's built, and *how it gets into a customer's hands*. Selling points: actual end-to-end output, on-premise privacy, kernel-sandboxed tool calling, DAP debugger, and a self-improving loop (DPO + GEPA).

This is the build order, the crate map, the wire shapes, the deployment artifacts, the component-placement matrix, and the "what to ship in week N" plan — written so a developer can pick it up and start building, *and* an ops team can pick it up and deploy it.

Backlinks: [[Index]], [[Sovereign_Coding_Agent]], [[LLM_Packaging]], [[Tooling_Benefits]], [[Codex_App]], [[Cursor]], [[Hermes]], [[Harness_Design_Principles]]

---

## 0. What the field has decided in 2026 — a research pass

Before committing to a build, it's worth grounding the decisions below in the consensus that crystallized across the harness-engineering literature in early 2026. Three pieces of writing converged on the same shape and are worth treating as load-bearing:

1. **["Agent = Model + Harness"](https://martinfowler.com/articles/harness-engineering.html)** (Martin Fowler) and **[OpenAI's harness-engineering note](https://openai.com/index/harness-engineering/)** — the *harness* is the product, the model is interchangeable. The defining example is Manus, [acquired by Meta for $2B in December 2025](https://www.nxcode.io/resources/news/harness-engineering-complete-guide-ai-agent-codex-2026) — Manus uses foundation models from Anthropic and OpenAI; what was acquired is the harness. The Sovereign Coding Agent design takes the same bet (Qwen is the model, the harness is the moat).
2. **[Anthropic's "Effective harnesses for long-running agents"](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)** (April 2026) — multi-hour autonomous coding sessions are made tractable by *splitting roles*: an Initializer agent sets up environment + feature list + progress tracker, a Coding agent makes incremental progress with explicit handoff artifacts. The Sovereign Coding Agent's Manager-Worker split ([[Sovereign_Coding_Agent#5. Server-Side Model Serving|§5]]) and review-loop checkpoint ([[Sovereign_Coding_Agent#10. Iterative Review Loop|§10]]) sit in the same family.
3. **["The Anatomy of an Agent Harness"](https://blog.dailydoseofds.com/p/the-anatomy-of-an-agent-harness)** (Avi Chawla, March 2026) — every functioning harness consists of the **same 11 components**: orchestration loop, tools, memory, context management, prompt construction, output parsing, state management, error handling, guardrails, verification loops, sub-agent orchestration. Anything missing is a known gap; anything novel is in *how* a component is implemented, not in *which* components exist. This list is the canonical checklist the Sovereign Coding Agent is built against (§2 below).

What this means practically: the architectural choices in [[Sovereign_Coding_Agent]] are *defensible against the consensus*, not exotic. The differentiation is in *combination* — DAP + project-scoped LanceDB + DPO-on-review + Manager-Worker, which no shipping harness has all four of (see [[Sovereign_Coding_Agent#16.3 Where this plan stands alone|§16.3]]).

---

## 1. TL;DR — the bet

| Layer | Choice | Why |
|---|---|---|
| **Client shell** | Electron + React + Monaco | Web-tech velocity for the diff/review UI; daemon split keeps the renderer small (see §3). Tauri considered and rejected for V1 — discussion in §3.2 |
| **Local daemon** | **Rust** (single static binary, ~30–60 MB resident) | LanceDB + tree-sitter native, `tokio` async runtime, deterministic shutdown for debugger subprocesses |
| **Local↔daemon IPC** | Localhost WSS + per-launch HMAC token, JSON-RPC 2.0 framing | Same protocol shape as the upstream WSS; renderer + future CLIs share one client; matches [[Codex_App|Codex's `codex-app-server`]] |
| **Daemon↔server** | **WSS + mTLS** (Envoy AI Gateway → Rust orchestrator) over corporate VPN | Bidirectional streaming, multiplexed, TLS-inspector-friendly |
| **Server inference** | **vLLM** Manager (Qwen 3.6-27B FP8) + Worker (Qwen3-Coder-7B FP8 *or* Granite 4.1 8B FP8) | Continuous batching, prefix caching, multi-LoRA, MTP speculative decoding |
| **Tools** | Shell (kernel-sandboxed), fs (dry-run), git, **LSP**, **DAP**, vector search, **MCP client**, browser-use (V2) | Per [[Tooling_Benefits]] |
| **Persistence** | LanceDB (laptop, per project), SQLite (laptop, per session), Postgres (server, preference DB), Qdrant (server, shared docs), MinIO (server, cold archive) | One store per concern; see §10 below |
| **Observability** | OpenTelemetry GenAI semantic conventions + Prometheus + Loki + Grafana + Tempo | Cross-vendor portable, open-source stack, customer ops teams already run it |
| **Self-improvement** | **DPO LoRA quarterly** + **GEPA weekly** | Two-loop pattern from [[Hermes#The self-evolution loop]] |

---

## 2. The harness, in 11 components

[The Anatomy of an Agent Harness](https://blog.dailydoseofds.com/p/the-anatomy-of-an-agent-harness) names the 11 functional pieces every working harness has. The Sovereign Coding Agent's implementation maps onto each one:

| # | Harness component | Where in this plan | Where in the daemon | Status |
|---|---|---|---|---|
| 1 | **Orchestration loop** | §4.3 (the agent loop) | `companycode-core::AgentLoop` | Phase 0 |
| 2 | **Tools** | §6 | `companycode-tools/*` | Phase 3–4 |
| 3 | **Memory** | [[Sovereign_Coding_Agent#6.1 Context Layers (Manager target ≈ 24 K tokens)|§6.1]] L2/L3/L8/L9 + LanceDB | `companycode-context` + `companycode-index` + SQLite | Phase 1, 5 |
| 4 | **Context management** | §4.4 (Priompt-style priorities) | `companycode-context::PromptAssembler` | Phase 1 |
| 5 | **Prompt construction** | §4.4 + L0–L10 layers | `companycode-context` builds the prompt; `companycode-upstream` ships it | Phase 1 |
| 6 | **Output parsing** | JSON-RPC 2.0 typed tool calls | `companycode-protocol::Event::ToolCallBegin` | Phase 0 |
| 7 | **State management** | Submit/event with `Op` queue + `resume_token` | `companycode-core::AgentLoop` + SQLite for review state | Phase 0–5 |
| 8 | **Error handling** | Tool failures as data, not exceptions | `Event::Error` carries `AgentError`; orchestrator never breaks the loop on a single tool failure | Phase 1 |
| 9 | **Guardrails / safety** | Sandbox + dry-run writes + prompt-injection boundary + secret scrubbing | `companycode-sandbox`, [[Sovereign_Coding_Agent#11. Security & Privacy|§11]] | Phase 3, 7 |
| 10 | **Verification loops** | Review surface + DAP runtime checks + tests-in-the-loop | Electron diff viewer + DAP tools + `shell.exec` running tests | Phase 4–5 |
| 11 | **Sub-agent orchestration** | Manager-Worker split + (V2) worktree-per-session | Orchestrator routing in §7 | Phase 2 (intra-model); V2 (worktree) |

This is not optional decomposition: it's the checklist a code reviewer should hold the daemon up against during Phase 1–2 reviews. **Missing any one of these eleven is a known-failure mode**, and the consensus in 2026 is that "missing X" is harder to retrofit than to spec from day one.

---

## 3. Client architecture — Electron + Rust split

### 3.1 The split

```
┌──────────── Electron (~150 MB resident) ────────────────────┐
│  Main (Node)                                                 │
│   • OS integration, autoupdate                               │
│   • Spawns Rust daemon as child process                      │
│   • Reads daemon's first stdout line: bind URL + auth token │
│   • Exposes `window.agentConn` via contextBridge             │
│  Renderer (Chromium)                                         │
│   • React + Tailwind + Monaco diff editor                    │
│   • Connects to daemon over loopback WSS                     │
│   • Project list, chat, review surface, settings             │
└────────────┬─────────────────────────────────────────────────┘
             │ wss://127.0.0.1:<port>  (per-launch HMAC token)
             ▼
┌──────────── Rust daemon (~30–60 MB resident) ───────────────┐
│  • Project registry & file watcher (notify)                  │
│  • Tree-sitter chunker                                       │
│  • LanceDB embedded                                          │
│  • Tool executor (shell / fs / git / LSP / DAP)              │
│  • MCP client                                                │
│  • Context assembler (L0–L10, Priompt-style priorities)      │
│  • Upstream WSS client (multiplex, reconnect)                │
│  • Local SQLite (sessions, review state)                     │
│  • Local logger + telemetry buffer                           │
└─────────────────┬───────────────────────────────────────────┘
                  │ WSS + mTLS over VPN
                  ▼
   [ Envoy AI Gateway → Orchestrator → vLLM Manager / Worker ]
```

**Why this split.** Electron is great at UI and bad at memory; Rust is the opposite. Pushing every heavy operation (vector indexing, tree-sitter parsing, LSP, file watching, debugger management) into the Rust daemon means the renderer stays *small* and *responsive*. The daemon is portable: Electron is one client, but `companycode` CLI and an editor extension can speak the same loopback protocol later.

This is the same shape Codex landed on ([[Codex_App#The Rust core: codex-rs]]) and Hermes landed on ([[Hermes#Editor integration via ACP]]), independently. It's also the shape the unrelated-but-instructive [DAEMON IDE](https://github.com/nullxnothing/daemon) on GitHub adopted: Electron main process owns SQLite (WAL mode) + IPC handlers; renderer talks only via IPC; every IPC handler returns `{ok, data} | {ok, error}` — never a raw throw across the bridge. **That last rule is worth copying verbatim**: it eliminates the unhandled-promise-rejection class of bugs that otherwise haunts Electron apps.

### 3.2 Tauri considered and rejected for V1

[Tauri](https://tauri.app/) is the obvious "Rust-only" alternative. The 2026 numbers are real: ~2–3 MB binary vs Electron's 60 MB+, 40 % faster startup, 30 % less memory ([Tauri vs Electron 2026](https://www.pkgpulse.com/blog/electron-vs-tauri-2026); [DoltHub comparison](https://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/)).

**Reasons to pick Tauri:**
- Single language (no Node/Rust split).
- Smaller binary — meaningful for a customer's IT team rolling out installers.
- Tighter security model (frontend ↔ Rust bridge with explicit permission allowlist).

**Reasons we picked Electron for V1:**
- **Monaco diff editor.** The diff/review UI in [[Sovereign_Coding_Agent#10. Iterative Review Loop|§10]] is the product. Monaco-in-Electron Just Works; Monaco-in-Tauri-WebView2 has known issues with web-worker isolation, complex CSS, and the inline-decorations API.
- **xterm.js** for the integrated terminal (matching [[Codex_App|Codex's]] desktop app pattern). Same story as Monaco — runs everywhere in Electron, has rough edges in WebView2.
- **Velocity.** The Sovereign Coding Agent ships in 30 weeks of phased rollout. The Tauri "rust tax" hits exactly the surfaces (UI, frontend tooling) where it needs to move fastest.

**Path to Tauri V2.** When V1 is out the door and the renderer is stable, *port the renderer behind an abstraction* (`@/runtime/electron.ts` vs `@/runtime/tauri.ts`) and migrate. Tauri 2.x has matured on the Monaco issue; by V2 it may not be a blocker. Don't try to build on both at once.

### 3.3 Loopback protocol

Per [[Sovereign_Coding_Agent#9.5 IPC: localhost WSS, not Electron contextBridge|§9.5]], the renderer talks to the daemon over **loopback WSS** with a per-launch HMAC token. The daemon binds to a random high port; the Electron main reads "URL + token" from the daemon's first stdout line and pushes it to the renderer via `contextBridge`.

**Refinements vs the design doc:**

- **Use JSON-RPC 2.0 framing** instead of ad-hoc JSON-lines. This matches [[Codex_App#The Rust core: codex-rs|Codex's `codex-app-server`]] and means TypeScript types can be generated from the Rust definitions via `ts-rs` or `specta` — drift-free wire schema.
- **Same protocol for upstream.** The daemon's upstream connection to the orchestrator uses the *same* JSON-RPC 2.0 framing, just with mTLS instead of HMAC and a different transport (WSS over VPN). One protocol, two transports.
- **IPC return contract.** Every IPC handler returns `{ok, data} | {ok, error}` — never throw across the bridge. This is the convention the [DAEMON IDE](https://github.com/nullxnothing/daemon) project codifies and it generalizes well.

### 3.4 Code signing, notarization, autoupdate

Three production realities that aren't in the design doc but block GA:

- **macOS:** the `.app` must be signed with an Apple Developer ID and notarized via Apple's automated service ([Electron docs](https://www.electronjs.org/docs/latest/tutorial/code-signing); [BigBinary walkthrough](https://www.bigbinary.com/blog/code-sign-notorize-mac-desktop-app)). Unsigned builds trigger Gatekeeper warnings on every launch.
- **Windows:** since June 2023, Microsoft requires an **Extended Validation (EV) code-signing certificate** ([Electron-builder docs](https://www.electron.build/code-signing.html)). Standard code signing certificates are no longer accepted by SmartScreen reputation. NSIS installer is the standard packaging format.
- **Linux:** AppImage + tarball; signing is via GPG, and customers' enterprise package managers (RPM, deb) usually want their own signing.
- **Autoupdate:** [`electron-builder`'s autoupdater](https://www.electron.build/auto-update.html) generates `latest.yml` / `latest-mac.yml` / `latest-linux.yml` and ships through GitHub Releases or an internal artifact server. For air-gapped customers, autoupdate has to point at the customer's internal CDN, not GitHub — make this configurable on first launch.

| OS | Cert type | Format | Cost / yr | Tool |
|---|---|---|---|---|
| macOS | Apple Developer ID | `.dmg` (signed/notarized) + `.zip` (for updater) | $99 | `electron-osx-sign` + `@electron/notarize` |
| Windows | EV code-signing | `.exe` (NSIS) | ~$200–600 | `electron-builder` |
| Linux | GPG signing key | `.AppImage`, `.deb`, `.rpm` | n/a | `electron-builder` |

Both certificate procurement and autoupdate infrastructure need to be in place by **Phase 6 (pilot)**, not Phase 9, because the pilot installs the signed build.

---

## 4. Daemon architecture (Rust)

### 4.1 Crate layout

```
companycode/
├── Cargo.toml                    # workspace
├── crates/
│   ├── companycode-cli/          # entry point: spawns daemon, tails logs, headless mode
│   ├── companycode-daemon/       # the long-running binary the Electron client launches
│   ├── companycode-core/         # the engine — agent loop, tool dispatch, context assembly
│   ├── companycode-protocol/     # wire types (shared with TypeScript via specta)
│   ├── companycode-tools/        # tool implementations behind a trait
│   │   ├── shell/                # sandboxed shell.exec
│   │   ├── fs/                   # fs.read / fs.write (dry-run)
│   │   ├── git/                  # status / diff / blame / log
│   │   ├── lsp/                  # symbols / refs / diagnostics / hover / rename / format
│   │   ├── dap/                  # debugger session manager (DAP client)
│   │   ├── vector/               # vector.search against LanceDB
│   │   └── mcp/                  # MCP client (later: server)
│   ├── companycode-context/      # Priompt-style context assembler with priority eviction
│   ├── companycode-index/        # tree-sitter chunker + LanceDB writer + file watcher
│   ├── companycode-sandbox/      # Landlock+seccomp / Seatbelt / restricted-token wrappers
│   ├── companycode-config/       # layered TOML resolution (system / user / project)
│   └── companycode-upstream/     # WSS+mTLS client with reconnect, resume_token
└── electron/                     # the Electron client (TypeScript)
```

About 12 crates, sized to be navigable by one person. The split is sharp enough that a contributor can pick up one crate without learning the rest.

### 4.2 Cargo dependencies

```toml
[workspace.dependencies]
# Async runtime
tokio              = { version = "1", features = ["full"] }
tokio-tungstenite  = { version = "0.24", features = ["rustls-tls-native-roots"] }
axum               = "0.7"

# Wire format
serde              = { version = "1", features = ["derive"] }
serde_json         = "1"
rmp-serde          = "1"            # MessagePack for binary mode
specta             = "2"            # rust-to-typescript schema generation
ts-rs              = "10"            # alternative; pick one

# Filesystem & code parsing
notify             = "7"
tree-sitter        = "0.24"
tree-sitter-rust   = "0.24"
tree-sitter-python = "0.24"
tree-sitter-typescript = "0.24"
# … per-language grammars

# Vector DB
lancedb            = "0.10"

# LSP client
lsp-types          = "0.97"
tower-lsp          = "0.20"

# DAP client (own thin client; protocol surface is small)
# We implement DAP in companycode-tools/dap directly using serde_json + tokio process

# Storage / auth
sqlx               = { version = "0.8", features = ["sqlite", "runtime-tokio-rustls"] }
ulid               = "1"
keyring            = "3"

# Sandbox helpers
landlock           = "0.4"          # Linux only (cfg attr)
seccompiler        = "0.5"          # Linux only

# MCP
async-trait        = "0.1"
# (write a small MCP client; the protocol is JSON-RPC 2.0 over stdio or HTTP)

# Secrets scrub
gitleaks-rs        = "*"            # or shell out to gitleaks

# Observability
tracing            = "0.1"
tracing-subscriber = "0.3"
opentelemetry      = "0.27"
opentelemetry-otlp = "0.27"
opentelemetry-semantic-conventions = "0.27"   # GenAI conventions
```

`rustls` everywhere, no OpenSSL. Statically-linked binary.

### 4.3 The agent loop (in `companycode-core`)

Submit/event, not request/response — same shape as Codex (see [[Codex_App#The agent loop]]):

```rust
// Operation submitted by the renderer or upstream
pub enum Op {
    UserTurn { task: String, context: ContextHint },
    Approval { request_id: Ulid, approved: bool },
    Cancel   { session_id: Ulid },
    Ping,
}

// Events streamed back
pub enum Event {
    AgentMessageDelta  { session_id: Ulid, text: String },
    ToolCallBegin      { tool: String, args: serde_json::Value, request_id: Ulid },
    ToolCallEnd        { request_id: Ulid, result: ToolResult },
    ToolEvent          { event: ToolEventBody },        // async DAP "stopped", etc.
    ReviewStateUpdate  { session_id: Ulid, state: ReviewState },
    Compaction         { session_id: Ulid, summary: String },
    TurnFinished       { session_id: Ulid, usage: TokenUsage },
    Error              { session_id: Ulid, error: AgentError },
}

pub struct AgentLoop { /* … */ }

impl AgentLoop {
    pub async fn run(&mut self) {
        while let Some(op) = self.ops_rx.recv().await {
            match op {
                Op::UserTurn { task, context } => self.handle_turn(task, context).await,
                Op::Approval { request_id, approved } => self.resolve_approval(request_id, approved),
                Op::Cancel   { session_id } => self.cancel(session_id),
                Op::Ping => self.events_tx.send(Event::Pong).await.ok(),
            }
        }
    }
}
```

The renderer or upstream submits `Op`s, the daemon emits `Event`s. **Renderer never blocks on tool execution**; it just consumes the event stream.

### 4.4 Context assembly with Priompt-style priorities

[[Sovereign_Coding_Agent#6.1 Context Layers (Manager target ≈ 24 K tokens)|§6.1]]'s static layer table is the right *taxonomy*, but it has no graceful degradation when L4 + L6 + L9 spike together. Borrow the [[Cursor#Layer 2: AI orchestration|Priompt]] approach: each item in the assembled prompt has a priority score; if total tokens exceed the budget, drop lowest-priority items via binary search.

Concretely, every context-source emits `PromptFragment { content, tokens, priority, layer_id }`. The assembler binary-searches for the highest threshold T such that `sum(tokens for items where priority ≥ T) ≤ budget`. Same as [Priompt](https://github.com/anysphere/priompt); same as a JSX with `priority` props except in Rust.

This is also what [[Hermes#Context management|Hermes's `context_compressor`]] is doing — middle turns get summarized when the budget tightens. The two patterns compose: priority-budgeting first, lossy compression of low-priority items second.

### 4.5 Sandbox layer

`companycode-sandbox` exposes a single trait:

```rust
pub trait Sandbox {
    fn run_with_policy(&self, cmd: Command, policy: &SandboxPolicy) -> Result<Child>;
}

pub struct SandboxPolicy {
    pub fs_read_roots:  Vec<PathBuf>,   // allowlist; empty = read-everywhere
    pub fs_write_roots: Vec<PathBuf>,   // strict allowlist
    pub network:        NetworkPolicy,  // None | Allowlist(Vec<Domain>)
    pub timeout:        Duration,
    pub cpu_time:       Option<Duration>,
}
```

Three implementations (cfg-gated):

- **Linux:** Landlock for filesystem, seccompiler for syscalls (`connect`, `bind`, `sendto` denied). Forks a small helper that applies the policy and execs the actual command.
- **macOS:** `sandbox-exec` with a Seatbelt SBPL profile generated from the policy.
- **Windows:** restricted token + ACL-locked job object. This is the weakest enforcement of the three — match Codex's known-state-of-the-art ([[Codex_App#Sandboxing — the part that actually matters]]).

For V1, **Linux is the priority** because the GPU server is Linux and most enterprise developers use macOS/Linux. Windows ships a softer sandbox and a flag noting the gap, matching Codex's transparent positioning.

### 4.6 DAP debugger module (`companycode-tools/dap`)

The wire surface is small (~600 lines of Rust):

```rust
// Implements the agent-side DAP client.
pub struct DapClient { /* tokio Process + stdio JSON-RPC */ }

impl DapClient {
    pub async fn launch(adapter: DapAdapter, launch_args: serde_json::Value) -> Result<Self>;
    pub async fn set_breakpoint(&mut self, file: &Path, line: u32, condition: Option<&str>) -> Result<BreakpointId>;
    pub async fn continue_(&mut self, thread: ThreadId) -> Result<()>;
    pub async fn step_over(&mut self, thread: ThreadId) -> Result<()>;
    pub async fn stack_trace(&mut self, thread: ThreadId) -> Result<Vec<StackFrame>>;
    pub async fn scopes(&mut self, frame: FrameId) -> Result<Vec<Scope>>;
    pub async fn variables(&mut self, ref_: VariableRef) -> Result<Vec<Variable>>;
    pub async fn evaluate(&mut self, frame: FrameId, expr: &str) -> Result<EvalResult>;
    pub async fn terminate(self) -> Result<()>;
}

pub enum DapAdapter {
    Python,    // spawn `python -m debugpy.adapter`
    NodeJs,    // spawn js-debug
    Rust,      // spawn codelldb
    Go,        // spawn `dlv dap`
    Java,      // spawn java-debug
    DotNet,    // spawn netcoredbg
    Ruby,      // spawn rdbg
}
```

The session manager keeps a `HashMap<SessionId, DapClient>` and translates agent tool calls to DAP requests. Async DAP events (`stopped`, `terminated`, `output`) are multiplexed back as `ToolEvent`s.

**Auto-detected launch configs** (per [[Sovereign_Coding_Agent#8.2.4 Auto-detected launch configurations|§8.2.4]]) live as small TOML files per language. The daemon picks the right one based on the user's task ("fix the failing test in `auth/session_test.py`" → Python pytest launch).

Reference implementations in the wild:
- [`mcp-debugger`](https://github.com/debugmcp/mcp-debugger) — DAP-over-MCP bridge with 1,266+ tests passing across Python, Node, Rust, Go, Java, .NET. Don't import; *do* read for the debug-adapter wrangling logic.
- [`go-delve/mcp-dap-server`](https://github.com/go-delve/mcp-dap-server) — Go-specific DAP-MCP bridge with the cleanest implementation of the Delve adapter.
- [Microsoft DebugMCP](https://github.com/microsoft/DebugMCP) — VS Code's official DAP-MCP server; the "what does Microsoft think" reference.

### 4.7 LSP module

Spawn `rust-analyzer`, `pyright`, `typescript-language-server`, etc. as child processes. `tower-lsp-client` for the client side. Cache server handles per-project; tear them down on project close or 5 min idle.

Tool surface (per [[Tooling_Benefits#LSP — language server as a tool]]):

```rust
lsp.symbols       (file)              -> Vec<Symbol>
lsp.refs          (symbol_id)         -> Vec<Location>
lsp.diagnostics   (file?)             -> Vec<Diagnostic>
lsp.hover         (file, position)    -> HoverInfo
lsp.definition    (file, position)    -> Location
lsp.rename        (symbol, new_name)  -> WorkspaceEdit  (review surface)
lsp.code_action   (file, range)       -> Vec<CodeAction>
lsp.format        (file)              -> WorkspaceEdit  (review surface)
```

`rename` and `format` are *write* operations and route through the review surface like `fs.write` does.

### 4.8 MCP client

Small implementation: JSON-RPC 2.0 client over stdio (for local MCP servers) or HTTP/SSE (for remote ones), with **OAuth 2.1 PKCE** for auth ([[Hermes#Tool-system depth|the Hermes bar]]). Discovery: each project's `.companycode/mcp.toml` lists configured servers; the daemon spawns/connects to them on project open.

For enterprise customers, the [2026 MCP architecture patterns guide](https://medium.com/cdata-software/7-key-mcp-architecture-patterns-for-enterprise-data-integration-8f6a3fcd7cf4) recommends **one MCP server per bounded context** (CRM, finance, code, knowledge base) behind existing auth fabric — that maps cleanly onto the per-project `mcp.toml` we expose.

### 4.9 Vector indexing pipeline

Per [[Sovereign_Coding_Agent#7.4 Indexing Strategy|§7.4]]: tree-sitter parse → cAST chunk at function/class boundaries → embed batch via `/embed` endpoint → write to LanceDB with metadata. `notify` watches the worktree; debounce 500 ms; re-chunk only touched files. Embedding cache is content-hash keyed.

Performance target: 30–50 K LOC/min on a typical repo. A 500K-LOC repo indexes in ~10–17 min the first time.

---

## 5. Server architecture (recap, see [[LLM_Packaging]])

```
Customer GPU server (1× RTX PRO 6000 96GB Blackwell, ~$13K all-in)

  Envoy AI Gateway     ──┐    TLS 1.3 + mTLS + JWT validation
  (TLS terminator)        │
                          ▼
  companycode-orchestrator (Rust, axum)
   • routes Manager vs Worker (rules now, classifier later)
   • streams tool_call/tool_result through to daemon
   • prefix-cache-aware request shaping
                          │
   ┌──────────────────────┼─────────────────────┐
   ▼                      ▼                     ▼
  vLLM Manager        vLLM Worker        embed + rerank
  (Qwen3.6-27B FP8)   (Qwen3-Coder-7B    (jina-embeddings-v3 + BGE-r-v2-m3
                       or Granite 4.1 8B)  on GPU 1)

  Postgres (preference DB) · Qdrant (shared docs index) · MinIO (cold archive)
  Prometheus + Loki + Grafana + Tempo (OTel GenAI semantic conventions)
```

The orchestrator is its own ~3 K-LOC Rust binary, mostly multiplexing WSS streams and applying the routing policy from [[Sovereign_Coding_Agent#5.6 Routing Policy|§5.6]].

For multi-replica scale, the [vLLM Production Stack](https://github.com/vllm-project/production-stack) provides the reference K8s deployment: a **request router** that does session-ID-based dispatch to maximize KV-cache reuse, plus the vLLM serving engines, plus a Prometheus + Grafana observability layer wired in. Helm chart-installable as `helm install vllm vllm/vllm-stack -f values.yaml`. **Adopt this when you outgrow Docker Compose** (~25+ devs); don't pre-emptively jump to K8s for 10 devs. See §11 below.

---

## 6. Tools — what to ship and why

The tool surface IS the product (see [[Tooling_Benefits]]). For V1, the minimum credible set:

| Tool | Source | Sandbox | Approval | Priority |
|---|---|---|---|---|
| `shell.exec` | Rust daemon, kernel-sandboxed | Landlock+seccomp / Seatbelt / Job Object | Per-command | **P0** |
| `fs.read` / `fs.write` (dry-run) | Rust daemon | Workspace-only | "Apply" in review surface | **P0** |
| `git.{status,diff,log,blame}` | shell out to `git` | Read-only | None | **P0** |
| `lsp.{symbols,refs,diagnostics,hover,definition}` | `tower-lsp-client` | Local | None | **P1** |
| `lsp.{rename,code_action,format}` | `tower-lsp-client` | Local, edits routed through review | "Apply" | **P1** |
| `vector.search` | LanceDB (laptop) | Local | None | **P0** |
| `debug.*` (DAP) | Rust daemon, DAP subprocess | Sandboxed subprocess | Per-session | **P1** (the differentiator) |
| `mcp.*` | MCP client w/ OAuth 2.1 PKCE | Per-server config | Configurable | **P2** |
| `web.search` | Internal docs endpoint, allowlisted | Egress-filtered | Per-project | **P2** |
| `browser.*` (Browser-Use via MCP) | MCP server | Ephemeral profile, allowlist | Per-task | **V2** |

**Tool shape rules** (from [[Harness_Design_Principles#Tool design]]):
- Typed JSON schema, required/optional split.
- Result = structured payload + truncated raw + size hint.
- Outputs >2 K tokens get compressed by the Worker before reaching the Manager.
- Errors are returned as `{ ok: false, ... }` data, not exceptions.
- Every write tool has a dry-run mode and routes through the review surface.

---

## 7. The link — VPN + WSS + mTLS

Per [[LLM_Packaging#The link — connecting laptop to server through a corporate network]]:

1. Customer's existing corporate VPN (or Tailscale / Headscale for smaller teams).
2. Daemon connects to `https://gpu-server.internal:443` over WSS with mTLS.
3. mTLS cert per laptop, provisioned at install time from a customer-side CA (Envoy AI Gateway can run that CA).
4. JWT in the upgrade headers, OIDC-issued, 15-min TTL.
5. `resume_token` per session so a WS drop doesn't kill an in-progress task.

This is a customer-IT-friendly setup: nothing exotic, all standard tooling, audit trail in Envoy + Loki.

---

## 8. Self-improvement — the two-loop pattern

| Loop | Optimizes | Cost | Cadence |
|---|---|---|---|
| **DPO LoRA** ([[Sovereign_Coding_Agent#12. Feedback Loop & Continuous Improvement|§12]]) | Manager weights | GPU days | Quarterly |
| **GEPA** ([[Hermes#The self-evolution loop|Hermes pattern]]) | Tool descriptions, system prompt phrasing, worker-briefing templates, skill code | $2–10 + a few hours | **Weekly** |

These don't conflict. GEPA evolves the *harness* between fine-tunes; DPO realigns the *model* on accumulated preference data. Together they cover the two timescales of improvement.

GEPA setup:

- Eval set: ~50–200 anonymized canonical company tasks from production traces.
- Signal: review-revise rate (proposals applied vs revised vs abandoned), token cost per applied hunk.
- Mutation targets: `companycode-tools/*/SCHEMA.json` (tool descriptions), `companycode-context/system_prompt.md` (system prompt template), `companycode-context/worker_brief.md` (briefing template).
- Search loop: GEPA proposes targeted edits, evaluates against the canonical set, Pareto-selects winners; ship the chosen variant gated by a hold-out eval.

DPO setup: as in [[Sovereign_Coding_Agent#12. Feedback Loop & Continuous Improvement|§12]] — preference pairs from approve/reject/edit signal → quarterly LoRA → vLLM hot-reload → 10 % canary → 50 % → 100 % over two weeks.

---

## 9. The selling-point pitch — what the demo says

Three (now four) lines:

1. **"Your code never leaves the network."** Self-hosted Qwen on a perimeter GPU; per-project LanceDB on the laptop; mTLS through your VPN.
2. **"Kernel-sandboxed tool calling."** Landlock + seccomp on Linux, Seatbelt on Mac. The agent *can't* escape the workspace — enforced by the OS, not by trust.
3. **"DAP debugger as a first-class tool."** Python, Node, Rust, Go, Java, .NET — set breakpoints, step, inspect runtime variables. The agent measures, doesn't guess.
4. **"Self-improving on your team's review patterns."** Every accepted hunk, rejected hunk, manual edit, and inline comment becomes preference data. Weekly prompt evolution (GEPA) plus quarterly DPO LoRA. Quality compounds.

If browser use ships in V2, that's the fifth line. Most demo-friendly: *"the agent opens the staging UI, runs the change, screenshots the result, attaches it to the diff."*

---

## 10. Where every component lives

**This is the section that turns a design doc into a deployable thing.** Every component named in [[Sovereign_Coding_Agent]] has to live somewhere — a process, a file, a database, a host. Here's the placement matrix.

### 10.1 Component placement matrix

| Component | Lives on | Process / artifact | Persistence | Privacy class | Failure-mode response |
|---|---|---|---|---|---|
| **Electron renderer (UI)** | Developer laptop | Chromium process inside `companycode.app` | None (state via daemon) | Local | UI can crash; daemon survives; renderer reconnects |
| **Electron main (Node)** | Developer laptop | Node process inside `companycode.app` | None | Local | Spawns daemon, holds installer / autoupdate state |
| **Rust daemon** | Developer laptop | Single binary `companycode-daemond` (~30–60 MB resident) | SQLite + LanceDB on disk | Local | Survives renderer crash; reconnects upstream WSS on drop |
| **LanceDB (per-project vector index)** | Developer laptop | In-process inside daemon | `%APPDATA%/CompanyCode/projects/<id>/lance/` | Local — never crosses the wire | Compaction on startup if fragmented >30%; stale eviction at 7 d |
| **SQLite (sessions, review state, telemetry buffer)** | Developer laptop | In-process inside daemon (WAL mode) | `%APPDATA%/CompanyCode/local.db` | Local | WAL replay on crash |
| **Local rolling log** | Developer laptop | `tracing` writer | `%APPDATA%/CompanyCode/logs/*.log` (24 h, 100 MB cap) | Local | Append-only, rotated nightly |
| **Embedding cache (content-hash keyed)** | Developer laptop | File on disk | `%APPDATA%/CompanyCode/projects/<id>/cache/embeddings.bin` | Local | Drop and re-embed on hash mismatch |
| **DAP debugger sessions** | Developer laptop | Subprocess(es) of daemon (`debugpy`, `codelldb`, `dlv`, …) | Ephemeral; stopped on session end | Local — variable values never leave laptop | Auto-terminate on parent exit |
| **LSP servers** | Developer laptop | Subprocesses of daemon (`pyright`, `rust-analyzer`, …) | Ephemeral | Local | Restart on per-project basis; idle-killed at 5 min |
| **OS keychain (at-rest encryption key)** | Developer laptop | macOS Keychain / Windows DPAPI / libsecret | Managed by OS | Local | Re-prompt on missing |
| **mTLS client cert** | Developer laptop | OS keychain + cert store | Per-laptop, provisioned at install | Local | Re-issue via gateway CA; 1-yr expiry |
| **Envoy AI Gateway** | Customer GPU server | `envoyproxy/ai-gateway` container | Config in `envoy.yaml`; logs to Loki | Server | Single point of TLS termination; dual-replica for HA |
| **Orchestrator** (`companycode-orchestrator`) | Customer GPU server | Rust binary, axum HTTP server | None (stateless) | Server | Multi-replica behind gateway; hash by session_id for prefix-cache affinity |
| **vLLM Manager** | Customer GPU server, GPU 0 | `vllm/vllm-openai` container | Model weights mount, KV cache in VRAM, prefix cache spill to NVMe | Server | Health-check restart; KV-cache spill to NVMe past 90% |
| **vLLM Worker** | Customer GPU server, GPU 1 | `vllm/vllm-openai` container | Model weights mount | Server | Same as Manager but lower-priority restart |
| **Embedding service** (jina-embeddings-v3) | Customer GPU server, GPU 1 | vLLM-served or HF TGI container | Model weights | Server | Re-spawn from cache |
| **Reranker** (BGE-reranker-v2-m3) | Customer GPU server, GPU 1 | TGI / FastAPI wrapper | Model weights | Server | Re-spawn from cache |
| **Postgres (preference DB)** | Customer GPU server | `postgres:16` container | Volume mount; 90-day retention, then archive | Server (scrubbed of PII) | Daily backup to MinIO |
| **Qdrant (shared docs index)** | Customer GPU server | `qdrant/qdrant` container | Volume mount | Server | Read-only; nightly ingest from Confluence/SharePoint |
| **MinIO (cold archive)** | Customer GPU server | `minio/minio` container | Bulk object storage on the 4 TB NVMe | Server | Holds Postgres backups, old preference data, model adapters |
| **Prometheus** | Customer GPU server | `prom/prometheus` container | TSDB volume; 14-day retention | Server | Single replica fine at this scale |
| **Loki** | Customer GPU server | `grafana/loki` container | TSDB volume; 30-day retention | Server | Indexes structured logs from orchestrator + vLLM |
| **Grafana** | Customer GPU server | `grafana/grafana` container | Dashboard JSON in version control | Server | Dashboards: model utilization, queue depth, review-revise rate |
| **Tempo (traces)** | Customer GPU server | `grafana/tempo` container | Object storage in MinIO | Server | OTel GenAI conventions throughout |
| **DPO trainer** (quarterly) | Customer GPU server (Manager GPU during off-hours) | Python job; LoRA via PEFT | Adapter checkpoint to MinIO | Server | Hold-out gate before deploy |
| **GEPA optimizer** (weekly) | Anywhere with API access | Python script (one-off run) | Mutation history → Git | Server-side eval; results land in `companycode-context` | Pareto-select winner against frozen eval set |
| **Sentry crash reports** (opt-in) | Customer-controlled or hosted | SaaS or self-hosted Sentry | Customer-managed | Hybrid (PII-scrubbed) | Disabled if customer self-hosts |

### 10.2 Privacy classes — what the column means

- **Local.** Never traverses the WSS to the server. Source files, vector embeddings, debugger sessions, raw tool output. The "code never leaves the network" guarantee is built on the *Local* row of this table.
- **Server.** Lives only on the customer's GPU server. Model weights, KV cache, structured logs, preference DB.
- **Hybrid (request-time).** A deliberately retrieved slice of laptop content (the L0–L10 prompt layers, [[Sovereign_Coding_Agent#6.1 Context Layers (Manager target ≈ 24 K tokens)|§6.1]]) crosses the wire each request. This is the only data flow where laptop state becomes server state, and it's bounded by the layer budgets.

### 10.3 Why each component is *where* it is

- **Vector DB on the laptop.** Per [[Sovereign_Coding_Agent#7. Vector Database — Bundled, Invisible|§7]], the index *is* the customer's source code in embedded form. Putting it on the server would mean shipping the whole repo across the wire on every project — and would lose the per-project isolation that prevents RAG cross-contamination ([[Tooling_Benefits#Vector retrieval — where the Sovereign Coding Agent already wins]]).
- **Logs split between laptop and server.** Local logs hold raw debugger state and tool output (privacy-sensitive). Server logs hold prompt fingerprints + outcomes (queryable by ops). Neither side has both.
- **Postgres on the server, SQLite on the laptop.** SQLite for single-process, single-writer state (review state, in-flight session). Postgres for many-writer team telemetry. This is the standard split — see [Langfuse's self-hosted topology](https://langfuse.com/self-hosting) and [DAEMON IDE's choice of SQLite-WAL-in-main-process](https://github.com/nullxnothing/daemon).
- **Model weights as volume mounts, not baked into images.** Models are 30+ GB each; baking them into Docker images means re-pulling on every change. Mount the host's `~/.cache/huggingface` and the [vLLM Docker production guide](https://inference.net/content/vllm-docker-deployment/) approach handles weight reuse cleanly.
- **MinIO instead of S3.** Customer's data lives in their perimeter; a self-hosted S3-API blob store satisfies "cold archive" without crossing the boundary. Same shape any reasonable enterprise customer already runs.
- **OTel GenAI conventions everywhere.** [The semantic conventions for generative AI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (LLM calls, token usage, model parameters, `gen_ai.operation.name`) [stabilized in early 2026](https://uptrace.dev/blog/opentelemetry-ai-systems). Adopting them now means traces interop with whatever APM the customer already runs (Datadog, Honeycomb, New Relic). Follow the [Red Hat "Distributed tracing for agentic workflows"](https://developers.redhat.com/articles/2026/04/06/distributed-tracing-agentic-workflows-opentelemetry) pattern: each tool call, LLM call, and retrieval step is a child span; correlate with `session.id` + `user.id` on the root span.

---

## 11. Packaging the product — from idea to artifact

This is the part that turns the daemon binary + an Electron app into something a customer's IT department can deploy on Tuesday morning.

### 11.1 Server bundle — `companycode-server-<version>.tar.gz`

Single signed tarball, ~38 GB (mostly model weights). Contents:

```
companycode-server-1.0.0/
├── docker-compose.yml             # 5 services: vllm-manager, vllm-worker, embed, rerank, orchestrator
├── docker-compose.observability.yml  # Prometheus + Loki + Grafana + Tempo + MinIO
├── envoy.yaml                     # AI Gateway config: TLS terminator, JWT validation, mTLS
├── orchestrator/                  # Rust binary, statically linked
├── images/
│   ├── vllm-openai-0.10.x.tar     # `docker load`-able (offline)
│   ├── envoy-ai-gateway.tar
│   ├── postgres-16.tar
│   ├── qdrant.tar
│   ├── minio.tar
│   └── grafana-stack.tar          # prometheus, loki, grafana, tempo
├── models/                        # ~38 GB
│   ├── Qwen3.6-27B-FP8/
│   ├── Qwen3-Coder-7B-FP8/
│   ├── jina-embeddings-v3/
│   └── BGE-reranker-v2-m3/
├── grafana/
│   └── dashboards/                # JSON: model_utilization.json, review_revise.json, …
├── runbooks/
│   ├── install.md
│   ├── upgrade.md
│   ├── on-call.md
│   └── disaster-recovery.md
├── certs/                         # CA setup scripts; not certs themselves
├── INSTALL.sh                     # idempotent install: docker compose up + health-check loop
├── SBOM.spdx.json                 # supply-chain attestation
└── checksums.sha256.sig           # signed manifest
```

Day-1 install:

```bash
tar xf companycode-server-1.0.0.tar.gz
cd companycode-server-1.0.0
./INSTALL.sh --gpu-spec auto --hf-cache /var/lib/companycode/hf
```

Day-2 ops:

```bash
docker compose pull && docker compose up -d   # rolling update
```

Phase-2 K8s migration is mechanical via the [vLLM Production Stack Helm chart](https://github.com/vllm-project/production-stack):

```bash
helm install vllm vllm/vllm-stack -f values.yaml
helm install companycode ./companycode-helm -f values.yaml
```

### 11.2 Air-gapped install — what changes

Most enterprise customers have at least *one* environment that can't reach the public internet. The server bundle is **already** mostly air-gap-friendly (images and weights bundled), but two things must be true:

1. **No `huggingface-cli download` in the install path.** Models are pre-staged in `models/`; vLLM is configured to read from the local mount.
2. **Container images bundled as `.tar` files** loadable via `docker load` (the bundle layout above does this). For K3s air-gapped install, follow the [official K3s air-gap guide](https://docs.k3s.io/installation/airgap) — ships images via a tarball that auto-loads on cluster startup.

The installer script signs each model tarball and verifies the signature on extract; an SBOM (`SBOM.spdx.json`) ships with the bundle for supply-chain review. This is the [Datacendia air-gapped deployment recipe](https://datacendia.com/learn/air-gapped-ai-deployment/) translated to this product.

For the *upgrade* path, customers receive incremental "delta bundles" containing only changed images and weights, signed and SBOM'd the same way.

### 11.3 Desktop installer — per-OS artifact

Built by `electron-builder` from CI:

| OS | Artifact | Size | Sign | Update channel |
|---|---|---|---|---|
| macOS | `CompanyCode-1.0.0.dmg` (signed/notarized) + `CompanyCode-1.0.0-mac.zip` | ~120 MB | Apple Developer ID | `latest-mac.yml` on internal CDN |
| Windows | `CompanyCode-Setup-1.0.0.exe` (NSIS, EV-signed) | ~150 MB | EV cert (DigiCert / GlobalSign) | `latest.yml` on internal CDN |
| Linux | `CompanyCode-1.0.0.AppImage` + `.deb` + `.rpm` | ~140 MB | GPG | `latest-linux.yml` on internal CDN |

The Rust daemon binary is bundled inside the Electron app (`Resources/companycode-daemond` on macOS, `resources/companycode-daemond.exe` on Windows). On first launch, the Electron main process spawns the daemon, reads the bind URL from its first stdout line, and hands it to the renderer.

First-launch flow (auto-bootstrap, borrowed from [[Gemma_Chat]]'s pattern):

```
1. Detect OS, mTLS cert path, gateway FQDN (from install flag or first-run prompt)
2. SSO via OIDC → JWT
3. Provision per-laptop mTLS cert from the gateway's CA endpoint
4. Spawn Rust daemon with cert + JWT
5. Open the app to the empty project list
6. User clicks "Add Project" → indexing begins → ready
```

Total time from double-click to first prompt: **<2 minutes** on a clean laptop, assuming network reachability.

### 11.4 Local trial install — `--local` flag

For demos or VPN-down fallback ([[LLM_Packaging#Degraded-mode "laptop fallback" for production]]):

```bash
CompanyCode-1.0.0.dmg  --local
```

The `--local` flag swaps the orchestrator URL for `http://localhost:11434/v1` and bundles an Ollama install + Qwen3-Coder-7B pull. Same UI, same daemon — no server needed. The `--local` artifact is ~5 GB larger because the model is included.

### 11.5 Distribution channels

| Channel | Audience | Auth | Update mechanism |
|---|---|---|---|
| **Customer-internal CDN** | Production developers | SSO | Autoupdate via `electron-updater`; URL configured at install |
| **GitHub Releases (private)** | Internal beta testers | GitHub OAuth | Direct download |
| **MinIO bucket on customer's GPU server** | Air-gapped customers | mTLS-only | `companycode update --check` polls; admin runs the update |
| **CI artifact archive** | Engineers debugging a specific build | LDAP | Direct download |

### 11.6 Versioning

[Semantic versioning](https://semver.org/), with a discipline:

- **Major** — wire-protocol break or storage-format break. Triggers a coordinated server + client release with a migration script. Aim for ≤1 per year.
- **Minor** — new features, no break. Both daemon and orchestrator forward-compatible. Monthly cadence.
- **Patch** — bug fixes, security patches. As needed.

The `companycode-protocol` crate version is a *floor*: the server announces the highest version it speaks; the daemon picks the highest both can understand. This is the same pattern Codex uses for `codex-app-server` versioning.

---

## 12. Idea → product — the path

The user-visible question this document answers: *how do I get from "I have an architecture spec" to "developers are using it"?* Eight phases, ~30 weeks, with a concrete artifact at every gate.

### 12.1 The phases

```
       │ Phase 0   │ Phase 1   │ Phase 2   │ Phase 3   │ Phase 4   │ Phase 5   │ Phase 6   │ Phase 7   │ Phase 8   │ Phase 9 GA
       │ Local     │ Wire +    │ Server    │ Sandbox + │ DAP       │ Review    │ Pilot     │ Hardening │ DPO       │
       │ POC       │ Infra     │ Stack     │ Tools     │ Debugger  │ Loop      │ (10 devs) │           │ first run │
Wks    │ 1–3       │ 4–7       │ 8–10      │ 11–13     │ 14–16     │ 17–19     │ 20–23     │ 24–26     │ 27–30     │ 31+
       │           │           │           │           │           │           │           │           │           │
Stake- │ Demo      │ Stable    │ End-to-   │ Match     │ Differ-   │ Primary   │ First     │ Ops-team  │ Self-     │ Wider
holder │ buy-in    │ wire =    │ end Qwen  │ Codex     │ entiator  │ UX surface│ real      │ ready     │ improving │ rollout
gate   │           │ contract  │ tasks     │ sandbox   │ live      │ live      │ users     │           │ live      │
       │           │           │           │           │           │           │           │           │           │
Arti-  │ Ollama+   │ JSON-RPC  │ Server    │ Kernel    │ Python    │ Monaco +  │ Signed    │ Grafana   │ LoRA      │ Multi-
fact   │ Qwen-7B   │ schema +  │ docker-   │ sandbox + │ DAP +     │ comments+ │ desktop   │ dashboards│ adapter   │ project
       │ in-app    │ TS types  │ compose   │ tool      │ Node DAP  │ manual    │ installers│ + run-    │ shipped + │ install
       │           │ generated │ up        │ surface   │           │ edits     │           │ books     │ canary    │ runbook
```

### 12.2 What unblocks each gate

| Phase | Unblocks the next when… |
|---|---|
| **0 — Local POC** | A developer can `npm run start`, open the app, ask "add a docstring to `foo()`", and watch a streaming proposal land. *Demo-able to a stakeholder by week 3*. |
| **1 — Wire + infra** | The JSON-RPC schema has TypeScript types generated from Rust definitions, and renderer↔daemon round-trips a request without bespoke code on either side. |
| **2 — Server stack** | A daemon on a laptop talks to vLLM Manager + Worker on the GPU server end-to-end; one canonical task ("fix this failing test") completes against the real Manager. |
| **3 — Sandbox + tools** | `shell.exec` writes outside the project root *fail at the kernel boundary*, not at the application layer. LSP rename/code-action/format work via the review loop. |
| **4 — DAP** | Agent fixes a Python bug it couldn't fix without a debugger. The demo: a test fails for a reason that requires inspecting `self._cached_token`; the agent does it. |
| **5 — Review loop** | A developer can comment "use is_valid()" on line 84, click "send → revise", and the next proposal addresses that comment exactly. Manual edits round-trip cleanly. |
| **6 — Pilot** | 10 internal devs are using it in their daily workflow; the daemon's telemetry buffer is filling with real review-revise data; ≥3 production tasks have been Applied. |
| **7 — Hardening** | An on-call engineer can answer the question "what broke?" by pasting a trace ID and finding the failed span in <5 minutes. Secret-scrub regex tests pass on a corpus of historical commits. |
| **8 — DPO** | A LoRA adapter trained on Q1 review signal beats the base model on the canonical-tasks eval; canary deploys at 10% with no regression. |
| **9 — GA** | A new customer can install the bundle in <1 hour from `tar xf` to "agent answers a real question". |

### 12.3 The risks worth taking before week 3

The single highest-leverage de-risk is **Phase 0**. Per the [2026 MVP playbook consensus](https://www.weweb.io/blog/mvp-development-complete-guide-from-idea-to-launch), the most common failure mode in AI-native MVPs is *building too much before testing the loop*. The Sovereign Coding Agent's loop is "user types a task → daemon does work → diff lands in review surface → user clicks Apply or comments". If that loop doesn't feel right at week 3 with a 7B local model, no amount of GPU spend in Phase 2 will save it.

Concretely: the Phase 0 deliverable is **not a polished UI**, it's a working loop. Use Ollama + Qwen3-Coder-7B locally ([[LLM_Packaging#The local 7 B trial — single-laptop POC]]); skip RAG entirely; one project; one tool (`shell.exec`); a stub UI. If the loop feels right, every later phase is plugging real components into a known-good shape. If the loop feels wrong, change the loop *before* committing to the rest of the plan.

### 12.4 Pricing and licensing — open decisions, not blockers

The architecture is agnostic to licensing model, but customers will ask. Three patterns are emerging in 2026 ([Gartner via aimultiple](https://research.aimultiple.com/ai-agent-pricing/); [Constellation Research 2026 trends](https://www.constellationr.com/blog-news/insights/enterprise-technology-2026-15-ai-saas-data-business-trends-watch); [the Monetizely 2026 pricing guide](https://www.getmonetizely.com/blogs/the-2026-guide-to-saas-ai-and-agentic-pricing-models)):

| Model | Fit for the Sovereign Coding Agent | Notes |
|---|---|---|
| **Per-developer seat** | Strong — predictable, customer-comfortable | Customers IT teams budget by seat anyway; aligns with "one app per laptop" |
| **Usage-based (tokens/hour-of-agent)** | Weak — at odds with self-hosted | All compute is the customer's anyway; charging on tokens means the customer pays twice |
| **Hybrid: seat + outcome bonuses** | Strong for premium tier | "Per applied PR" or "per resolved Sentry issue" kickers above a base seat fee |
| **Enterprise License Agreement (AELA)** | Strong for large rollouts | Flat fee, shared-risk; mature customers want this |

Given the architecture's "code never leaves the network" stance, **per-developer seat is the natural baseline** with an AELA option for ≥50-developer rollouts. This is also the [Gartner projection](https://research.aimultiple.com/ai-agent-pricing/) for what enterprise SaaS will normalize on by 2028: 40% of spend shifts to usage/agent/outcome-based pricing, but per-seat still dominates predictable enterprise budgets.

### 12.5 GTM — where the demo lands

For an enterprise sales motion ([2026 GTM playbooks consensus](https://wearepresta.com/startup-gtm-framework-2026-the-strategic-blueprint-for-intelligent-scaling/)):

1. **Discovery call** — qualify on three criteria: (a) ≥10 developers, (b) on-premise mandate (regulated industry, or refused-to-use-Cursor team), (c) existing GPU capacity or willingness to spend ~$13K.
2. **Local trial** — ship the `--local` Electron installer; demo on a laptop in <30 min. This is what Phase 0 buys you commercially.
3. **Pilot** — install the server bundle in their dev environment with 3–5 paid pilot users for 6 weeks. Goal: review-revise rate ≥ 60% applied within 2 iterations.
4. **Production** — the customer's IT team takes over. Run-book + on-call docs from Phase 7 are the handover artifact.

The "harness is the product" lesson from Manus/Meta isn't just a technical observation — it's a sales positioning: when a customer asks *"why not just have us run Cursor / Codex / Claude Code on Bedrock?"*, the answer is the four lines from §9, and the demo for line 3 (DAP) is the one no competitor can show.

---

## 13. Build order (revised vs [[Sovereign_Coding_Agent#14. Phased Rollout|§14]])

| Phase | Weeks | Scope | Deliverable artifact |
|---|---|---|---|
| **0 — Local POC** | 1–3 | Electron + Rust daemon, *Ollama serving Qwen3-Coder-7B locally*, one project, shell + fs + LSP tools, raw chat (no review surface yet) | A working laptop demo |
| **1 — Wire & infra** | 4–7 | JSON-RPC 2.0 protocol locked, specta-generated TS types, mTLS plumbing, Envoy AI Gateway docker-compose, sample customer install runbook | `companycode-protocol` crate v0.1; install runbook |
| **2 — Server stack** | 8–10 | vLLM Manager + Worker on the GPU server, embed + rerank, orchestrator binary, prefix caching live, daemon talks to server end-to-end | `companycode-server-0.2.tar.gz` (no observability yet) |
| **3 — Sandbox + tools** | 11–13 | Landlock+seccomp/Seatbelt, full tool surface (shell + fs + git + LSP w/ rename/code_action/format + vector + MCP client) | `companycode-sandbox` crate v1; tool surface complete |
| **4 — DAP** | 14–16 | Python first, then Node, Rust, Go. Per-session approval flow, auto-detected launches | `companycode-tools/dap` crate v1 with 4 adapters |
| **5 — Review loop** | 17–19 | Monaco diff viewer, comment threading, manual-edit tracking, L9 review-state injection, "send → revise" | Electron renderer v0.5 |
| **6 — Pilot** | 20–23 | Roll to 10 internal devs. Wire feedback capture (preference pairs into Postgres) | Signed Mac + Windows + Linux installers v0.6 |
| **7 — Hardening** | 24–26 | Observability dashboards (review-revise rate is the headline), egress controls, secret scrubbing pre-upload, on-call runbook | Grafana dashboard JSONs; Loki retention policy; runbook.md |
| **8 — DPO** | 27–30 | First DPO LoRA on collected review signal, canary deploy, canonical-eval gate. **Plus: GEPA weekly loop on system prompt + tool schemas.** | First LoRA adapter checkpointed to MinIO; canary metric dashboard |
| **9 — GA** | 31+ | Wider rollout. Evaluate scaling to 20–50 devs ([[Sovereign_Coding_Agent#5.5 Sizing & Linear Scaling|§5.5]]). Shared knowledge index ingest pipeline. | `companycode-server-1.0.0` GA bundle |
| **V2 — V2 candidates** | 31+ | Worktree-per-session (Codex pattern), browser-use via MCP, fleet view (Cursor pattern), MCP server mode, Tauri renderer migration, ACP editor adapter | Each shipped as a discrete v1.x release |

Total: 30 weeks to GA, plus a backlog of 5–10 high-leverage V2 features.

---

## 14. Open questions that block / unblock

### Blocks shipping V1

- **Windows DAP sandboxing.** debugpy + vscode-js-debug under restricted-token job objects — does that actually work end to end? Need a 1-week spike in Phase 0/1.
- **Conditional breakpoint latency.** debugpy with a complex condition can be slow. Need a daemon-side cap so the agent doesn't set a 200 ms-evaluating breakpoint inside a tight loop.
- **Embedding-model upgrade path.** Re-embedding the entire fleet's projects has real cost. Define the upgrade policy: keep previous model live for a quarter, dual-index in the background, swap atomically per project (per [[Sovereign_Coding_Agent#7.6 Index hygiene|§7.6]]).
- **EV code-signing certificate procurement.** Lead time for a new EV cert is 1–3 weeks plus hardware-token shipping. Start in Phase 1, not Phase 6.
- **Air-gapped weight distribution.** Customers behind air-gaps can't pull from Hugging Face. Define the offline weight-bundle workflow (signed tarball mirrored to the customer's internal artifact registry) before the first air-gapped customer pilot.

### Doesn't block, but worth tracking

- **Worker pick.** Qwen3-Coder-7B vs IBM Granite 4.1 8 B head-to-head on the Worker workload (compress files, triage logs, distill stack traces). Granite leads BFCLv3; Qwen wins on tokenizer alignment with the 27B Manager. Bake-off in Phase 2.
- **Aider Architect/Editor split.** Manager produces a structured plan, Worker emits the patches. Worth A/B-testing in Phase 5–6 once review-loop data accumulates.
- **MCP server mode** (vs just MCP client). Lets customer's other tools call the Sovereign Coding Agent as a service. V2.
- **Browser use** integration shape — direct Rust backend (chromiumoxide) vs MCP-bridge to Browser-Use Python. Lean MCP per [[Tooling_Benefits#How to ship it]].
- **Worktree-per-session.** Codex's parallel-agents pattern needs `git worktree` orchestration in the daemon. V2.
- **vLLM upgrade cadence.** vLLM moves fast (multiple breaking releases per quarter). Pin the bundle's vLLM version against the Qwen 3.6 recipe; bumping casually breaks prefix caching at minimum.
- **Tailscale/Headscale acceptance.** For customers without an existing VPN, [Tailscale](https://tailscale.com/) (or [Headscale](https://github.com/juanfont/headscale) self-hosted) is by far the smoothest path. Some security teams refuse Tailscale's control plane; document Headscale for those.

---

## 15. Cross-references — what each section comes from

- Architecture topology, communication layer, model topology, vector DB, tool surface, security, feedback, observability, phased rollout: [[Sovereign_Coding_Agent]] (the seed; this plan is the *implementation* of it).
- Codex CLI shape, kernel sandboxing, JSON-RPC app server: [[Codex_App]].
- Cursor Composer, Priompt, real-time RL: [[Cursor]].
- Hermes self-evolution (GEPA + DSPy), 7-backend execution selector, ACP editor adapter, MCP OAuth bar: [[Hermes]].
- Tool selling points (DAP, browser use, MCP, LSP): [[Tooling_Benefits]].
- Server bundle (Docker/K8s, Envoy AI Gateway, vLLM flags) and the local 7 B trial: [[LLM_Packaging]].
- Worker model alternatives (Granite 4.1 8B, Qwen3-Coder-7B, Hermes 4 8B): [[Small_Models_2026]].
- Benchmark interpretation rules: [[Coding_Benchmarks_2026]].
- Harness pillars (system prompt, tools, context, sub-agents, sandbox, observability, evals, MCP, permission): [[Harness_Design_Principles]].

---

## Sources

### Foundational harness research

- [Harness engineering for coding agent users — Martin Fowler](https://martinfowler.com/articles/harness-engineering.html)
- [Harness engineering: leveraging Codex in an agent-first world — OpenAI](https://openai.com/index/harness-engineering/)
- [Harness design for long-running application development — Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Effective harnesses for long-running agents — Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic Designs Three-Agent Harness — InfoQ (April 2026)](https://www.infoq.com/news/2026/04/anthropic-three-agent-harness-ai/)
- [The Anatomy of an Agent Harness — Avi Chawla](https://blog.dailydoseofds.com/p/the-anatomy-of-an-agent-harness)
- [Skill Issue: Harness Engineering for Coding Agents — HumanLayer](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [The Complete Guide to Harness Engineering 2026 — NxCode](https://www.nxcode.io/resources/news/harness-engineering-complete-guide-ai-agent-codex-2026)
- [Building a Production-Ready AI Agent Harness — DEV / apssouza22](https://dev.to/apssouza22/building-a-production-ready-ai-agent-harness-2570)

### Reference implementations to mine for patterns

- [DAEMON IDE (nullxnothing/daemon)](https://github.com/nullxnothing/daemon) — Electron + IPC contract pattern, SQLite-WAL-in-main-process
- [The codex-rs Architecture — Daniel Vaughan](https://codex.danielvaughan.com/2026/03/28/codex-rs-rust-rewrite-architecture/)
- [A Technical Blueprint for Local-First AI with Rust and Tauri — Musa Bello](https://medium.com/@Musbell008/a-technical-blueprint-for-local-first-ai-with-rust-and-tauri-b9211352bc0e)
- [Composer 2 Technical Report — Cursor](https://cursor.com/resources/Composer2.pdf)
- [Hermes Agent — architecture docs](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- [Priompt — anysphere/priompt](https://github.com/anysphere/priompt)

### Server packaging & deployment

- [vLLM Production Stack](https://github.com/vllm-project/production-stack)
- [Envoy AI Gateway](https://aigateway.envoyproxy.io/) and [docs](https://aigateway.envoyproxy.io/docs/)
- [vLLM Production Deployment: Complete 2026 Guide — SitePoint](https://www.sitepoint.com/vllm-production-deployment-guide-2026/)
- [vLLM Docker Deployment: Production-Ready Setup Guide (2026) — Inference.net](https://inference.net/content/vllm-docker-deployment/)
- [Self-Hosted LLM Guide 2026 — premai](https://blog.premai.io/self-hosted-llm-guide-setup-tools-cost-comparison-2026/)
- [LLM Gateway On-Premise Infrastructure — TrueFoundry](https://www.truefoundry.com/blog/llm-gateway-on-premise-infrastructure)
- [Self-host Langfuse (LLM Observability)](https://langfuse.com/self-hosting) — reference topology for app + worker + storage split
- [Self-hosted LangSmith — LangChain](https://docs.langchain.com/langsmith/self-hosted)
- [Deploying vLLM with Docker — Juan C Olamendy](https://medium.com/@juanc.olamendy/deploying-vllm-with-docker-the-complete-guide-to-production-ready-llm-inference-39b812c01535)

### Air-gap / on-prem GPU

- [Air-Gap Install — K3s](https://docs.k3s.io/installation/airgap)
- [Air-Gapped AI Deployment: Complete Guide — Datacendia](https://datacendia.com/learn/air-gapped-ai-deployment/)
- [Enterprise AI Code Assistants for Air-Gapped Environments — IntuitionLabs](https://intuitionlabs.ai/articles/enterprise-ai-code-assistants-air-gapped-environments)
- [Architecting GPUaaS for Enterprise AI On-Prem — Towards Data Science](https://towardsdatascience.com/architecting-gpuaas-for-enterprise-ai-on-prem/)
- [Cluster System Requirements — NVIDIA Run:ai Self-hosted](https://run-ai-docs.nvidia.com/self-hosted/getting-started/installation/install-using-helm/system-requirements)

### Desktop app distribution

- [Code Signing — Electron docs](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Code Signing — electron-builder](https://www.electron.build/code-signing.html)
- [Auto Update — electron-builder](https://www.electron.build/auto-update.html)
- [How to code-sign and notarize an Electron application — BigBinary](https://www.bigbinary.com/blog/code-sign-notorize-mac-desktop-app)
- [Implementing Auto-Updates in Electron with electron-updater — Nishikanta](https://blog.nishikanta.in/implementing-auto-updates-in-electron-with-electron-updater)
- [electron-builder on GitHub](https://github.com/electron-userland/electron-builder)

### Observability — OpenTelemetry GenAI

- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Distributed tracing for agentic workflows with OpenTelemetry — Red Hat](https://developers.redhat.com/articles/2026/04/06/distributed-tracing-agentic-workflows-opentelemetry)
- [OpenTelemetry for AI Systems: LLM and Agent Observability (2026) — Uptrace](https://uptrace.dev/blog/opentelemetry-ai-systems)
- [OpenTelemetry for AI Agents in MCP Workflows — MintMCP](https://www.mintmcp.com/blog/opentelemetry-ai-agents)
- [OpenTelemetry for LLMs — OpenObserve](https://openobserve.ai/blog/opentelemetry-for-llms/)
- [AI Agents Observability with OpenTelemetry and VictoriaMetrics — VictoriaMetrics](https://victoriametrics.com/blog/ai-agents-observability/)
- [Datadog LLM Observability + OTel GenAI — Datadog](https://www.datadoghq.com/blog/llm-otel-semantic-convention/)

### MCP enterprise deployment

- [The Complete Guide to Model Context Protocol (MCP) in 2026 — Essa Mamdani](https://www.essamamdani.com/blog/complete-guide-model-context-protocol-mcp-2026)
- [The 2026 MCP Roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [7 Key MCP Architecture Patterns for Enterprise Data Integration — CData](https://medium.com/cdata-software/7-key-mcp-architecture-patterns-for-enterprise-data-integration-8f6a3fcd7cf4)
- [Deploying MCP servers on Amazon ECS — AWS](https://aws.amazon.com/blogs/containers/deploying-model-context-protocol-mcp-servers-on-amazon-ecs/)
- [Model Context Protocol Enterprise Guide — Inductivee](https://inductivee.com/blog/model-context-protocol-enterprise-guide)
- [MCP Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)

### Idea-to-product / GTM

- [MVP Development: 2026 Guide From Idea to Launch — WeWeb](https://www.weweb.io/blog/mvp-development-complete-guide-from-idea-to-launch)
- [Startup GTM Framework 2026 — Presta](https://wearepresta.com/startup-gtm-framework-2026-the-strategic-blueprint-for-intelligent-scaling/)
- [Enterprise AI Roadmap: The Complete 2026 Guide — RTS Labs](https://rtslabs.com/enterprise-ai-roadmap/)
- [The 2026 Guide to SaaS, AI, and Agentic Pricing Models — Monetizely](https://www.getmonetizely.com/blogs/the-2026-guide-to-saas-ai-and-agentic-pricing-models)
- [From Traditional SaaS-Pricing to AI Agent Seats in 2026 — aimultiple](https://research.aimultiple.com/ai-agent-pricing/)
- [SaaS meets AI agents — Deloitte](https://www.deloitte.com/us/en/insights/industry/technology/technology-media-and-telecom-predictions/2026/saas-ai-agents.html)
- [Enterprise technology 2026: 15 AI, SaaS, data, business trends — Constellation Research](https://www.constellationr.com/blog-news/insights/enterprise-technology-2026-15-ai-saas-data-business-trends-watch)

### VPN / network

- [Tailscale](https://tailscale.com/)
- [Headscale (self-hosted Tailscale)](https://github.com/juanfont/headscale)

### Tooling & DAP

- [Debug Adapter Protocol — Microsoft](https://microsoft.github.io/debug-adapter-protocol/specification.html)
- [mcp-debugger](https://github.com/debugmcp/mcp-debugger)
- [go-delve/mcp-dap-server](https://github.com/go-delve/mcp-dap-server)
- [Microsoft DebugMCP](https://github.com/microsoft/DebugMCP)
- [Browser-Use](https://github.com/browser-use/browser-use)
- [LanceDB](https://github.com/lancedb/lancedb)
