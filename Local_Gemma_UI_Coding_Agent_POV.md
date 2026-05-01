---
tags: [local-pov, gemma, lm-studio, rust-daemon, electron, vector-db, sqlite]
status: draft
last_updated: 2026-04-30
---

# Local Gemma UI Coding Agent PoV

This plan narrows Aegis into a local proof of value: a polished desktop coding-agent UI backed by a small Rust daemon, LM Studio serving `google/gemma-4-E4B-it`, local SQLite logging, and an embedded project-scoped vector database. The goal is to prove the harness loop before paying for a server: tool calls, traceability, retrieval, diff review, and "open this change in my IDE" workflows.

The product promise for this PoV is simple:

1. Developer opens a folder in Aegis.
2. Aegis indexes the project locally.
3. Developer asks for a change.
4. Gemma drives tool calls through the Rust daemon.
5. Aegis shows every tool call, every file touched, the proposed diff, and the trace.
6. Developer can apply the patch or open the folder/file in VS Code, Visual Studio, or CLion.

Everything runs locally except whatever LM Studio itself may download during model setup. Source files, traces, vector indexes, and proposed patches stay on the workstation.

## 1. Scope

### In scope for the local PoV

| Area | Decision |
|---|---|
| Model runtime | LM Studio local server |
| Chat model | `google/gemma-4-E4B-it` loaded in LM Studio |
| Local API | OpenAI-compatible `http://localhost:1234/v1` |
| App shell | Electron + React + Monaco |
| Daemon | Rust, spawned by Electron main process |
| Local storage | SQLite for traces, sessions, project registry, settings |
| Vector DB | Embedded LanceDB per project, managed by the Rust daemon |
| Retrieval | Hybrid lexical + vector search over project chunks |
| Tools | `fs.read`, `fs.propose_patch`, `shell.exec`, `git.*`, `vector.search`, `ide.open` |
| IDE handoff | Open project/file/line in VS Code, Visual Studio, or CLion |
| Writes | Dry-run patch proposals first; apply only after user approval |

### Out of scope for this PoV

| Deferred item | Why |
|---|---|
| Server vLLM stack | Local harness proof comes first |
| Full DAP debugger | Add after the basic tool loop works |
| Multi-agent Manager/Worker | Gemma is one local model for now |
| DPO/GEPA | Need review traces first |
| Kernel-level sandbox | Start with workspace-scoped guardrails; hard sandbox later |
| MCP registry | Useful later; local first-party tools are faster for PoV |

## 2. Target Architecture

```text
Electron desktop app
  Main process
    - starts Rust daemon
    - manages app windows and updater later
    - passes daemon URL/token to renderer

  Renderer
    - React UI
    - Monaco diff viewer
    - tool timeline
    - project/index status
    - model/runtime health

localhost WebSocket / JSON-RPC

Rust daemon
  - project registry
  - SQLite trace/session DB
  - LanceDB project vector indexes
  - file watcher and indexer
  - tool executor
  - LM Studio OpenAI-compatible client
  - patch/diff engine
  - IDE launcher

LM Studio
  - Gemma 4 E4B-it chat model
  - optional local embedding model
  - OpenAI-compatible API on localhost:1234
```

The daemon is the product core. Electron can crash or reload; the daemon should keep sessions, traces, and project state intact.

## 3. LM Studio Contract

Use LM Studio as a local OpenAI-compatible server.

Default configuration:

```text
Base URL: http://localhost:1234/v1
API key: lm-studio
Chat endpoint: /v1/chat/completions
Models endpoint: /v1/models
Embeddings endpoint: /v1/embeddings, if an embedding model is loaded
```

The daemon should support two model clients behind one trait:

```rust
trait ModelClient {
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse>;
    async fn embed(&self, input: Vec<String>) -> Result<Vec<Vec<f32>>>;
    async fn list_models(&self) -> Result<Vec<ModelInfo>>;
}
```

For the first build, `LmStudioClient` implements that trait. Later, `VllmClient` can reuse the same app and daemon interfaces.

Gemma supports function/tool calling, but small local models can still emit malformed calls. The daemon should handle three paths:

1. Native LM Studio `tool_calls` parsed successfully.
2. Fallback parser extracts a JSON tool call from assistant text.
3. Repair turn asks the model to re-emit valid JSON matching the schema.

Do not let invalid tool output crash the loop. Log the parse failure and continue.

## 4. Rust Daemon Responsibilities

The daemon should be a small local service, not a giant platform. Its first job is to make local agent actions reliable and observable.

### Core modules

```text
aegis-daemon/
  crates/
    aegis-protocol/     JSON-RPC messages shared with UI
    aegis-core/         agent loop and session state
    aegis-model/        LM Studio client
    aegis-tools/        fs, shell, git, vector, ide tools
    aegis-index/        chunking, embeddings, LanceDB
    aegis-store/        SQLite schema and migrations
    aegis-patch/        unified diff generation and apply
    aegis-app/          daemon binary, config, startup
```

### Daemon startup

1. Bind to `127.0.0.1` on a random free port.
2. Generate a per-launch auth token.
3. Print one JSON line to stdout:

```json
{"url":"ws://127.0.0.1:43127","token":"..."}
```

4. Electron main reads that line and passes it to the renderer.
5. Renderer connects over WebSocket.

### Local data layout

On Windows:

```text
%APPDATA%/Aegis/
  aegis.db
  logs/
    daemon.log
  projects/
    <project-id>/
      meta.json
      lance/
      cache/
        embeddings/
      snapshots/
```

On macOS/Linux, use the standard app data directory from the Rust `directories` crate.

## 5. SQLite Logging and State

SQLite is the local source of truth for what happened.

### Tables

```sql
projects(
  id text primary key,
  name text not null,
  root_path text not null,
  preferred_ide text,
  created_at text not null,
  last_opened_at text
);

sessions(
  id text primary key,
  project_id text not null,
  title text,
  model_id text,
  started_at text not null,
  finished_at text,
  status text not null
);

turns(
  id text primary key,
  session_id text not null,
  user_message text not null,
  prompt_fingerprint text not null,
  started_at text not null,
  finished_at text,
  status text not null
);

tool_calls(
  id text primary key,
  turn_id text not null,
  tool_name text not null,
  args_json text not null,
  approved integer not null default 0,
  started_at text,
  finished_at text,
  status text not null,
  result_summary text,
  raw_result_path text
);

proposals(
  id text primary key,
  turn_id text not null,
  summary text,
  patch text not null,
  status text not null,
  created_at text not null
);

review_events(
  id text primary key,
  proposal_id text not null,
  kind text not null,
  file_path text,
  line integer,
  hunk_id text,
  body text,
  created_at text not null
);

index_chunks(
  id text primary key,
  project_id text not null,
  file_path text not null,
  line_start integer,
  line_end integer,
  content_hash text not null,
  symbol_name text,
  indexed_at text not null
);
```

Raw large tool outputs should go to capped files under `logs/tool-output/`, with paths referenced from SQLite. Keep SQLite fast and queryable.

### What the UI should expose

- Session trace ID.
- Model and quant currently loaded.
- Tool calls with duration and status.
- Commands run and whether the user approved them.
- Files read.
- Chunks retrieved from the vector DB.
- Patch generated.
- Apply/revise outcome.

This is the proof that Aegis is a harness, not a black box.

## 6. Vector Database and Retrieval

Use LanceDB as the embedded vector DB because it ships in-process with the Rust daemon and does not require a sidecar service. SQLite remains the operational DB; LanceDB is for semantic search.

### Why not only SQLite for vectors?

SQLite should own logs, settings, sessions, and review state. A vector extension such as sqlite-vec is worth tracking, but LanceDB is a better fit for the first PoV because the existing Aegis architecture already assumes project-scoped LanceDB and Rust-native vector storage.

### Indexing pipeline

On "Add Project":

1. Walk files under the project root.
2. Respect `.gitignore`.
3. Exclude common heavy folders:

```text
.git/
node_modules/
vendor/
.venv/
dist/
build/
target/
__pycache__/
*.lock
*.min.js
```

4. Chunk source files using tree-sitter where available.
5. Fallback to markdown/plaintext chunking for unsupported files.
6. Generate embeddings.
7. Store vectors and metadata in per-project LanceDB.
8. Store chunk metadata and indexing status in SQLite.

### Embedding strategy

For the first build, support two embedding providers:

| Provider | Use |
|---|---|
| LM Studio `/v1/embeddings` | Preferred if the user loads a local embedding model |
| Bundled ONNX embedding model | Fallback for a smoother installer later |

Recommended PoV default:

- Use LM Studio for Gemma chat.
- Use a small local embedding model for retrieval, such as `nomic-embed-text` or `bge-small-en`, loaded through LM Studio if available.
- If embeddings are unavailable, fall back to lexical search and show "semantic index unavailable" in the UI.

The vector DB should make Gemma smarter by retrieving focused project context before each turn. The daemon assembles:

```text
system prompt
tool schemas
project card
git status summary
top lexical hits
top vector hits
active file snippets
user request
```

### Retrieval tool

```json
{
  "name": "vector.search",
  "description": "Search the local project semantic index for code or docs relevant to a query.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "limit": { "type": "integer", "default": 8 }
    },
    "required": ["query"]
  }
}
```

Return:

```json
{
  "matches": [
    {
      "path": "src/auth/session.rs",
      "line_start": 42,
      "line_end": 88,
      "score": 0.82,
      "snippet": "..."
    }
  ]
}
```

## 7. Tool Surface

The first tool set should be small and reliable.

| Tool | Purpose | Approval |
|---|---|---|
| `fs.read` | Read a file in the project | No |
| `fs.list` | List project files with filters | No |
| `fs.propose_patch` | Create a patch proposal, not a direct write | No, but Apply is explicit |
| `shell.exec` | Run tests/builds or inspection commands | Yes |
| `git.status` | Read git status | No |
| `git.diff` | Read current diff | No |
| `git.log` | Read recent commits | No |
| `vector.search` | Search local semantic index | No |
| `ide.open_project` | Open the project in chosen IDE | No |
| `ide.open_file` | Open a file and line in chosen IDE | No |

Guardrails:

- No tool may read outside the project unless explicitly allowed.
- No command runs outside the project root.
- `shell.exec` defaults to no network assumptions and a 30 second timeout.
- `fs.propose_patch` never writes directly.
- Every tool call is logged before execution.
- Tool output is summarized for the model and stored raw only in local logs.

## 8. Patch and Review UX

The UI needs to make the agent's work inspectable.

### Required views

| View | Contents |
|---|---|
| Project sidebar | Added projects, index status, preferred IDE |
| Chat/task view | User prompt, streamed assistant messages |
| Tool timeline | Each tool call, args summary, status, duration |
| Context panel | Retrieved chunks and active files used |
| Diff view | Monaco unified or side-by-side diff |
| Review actions | Apply, discard, comment, revise |
| Trace panel | SQLite-backed trace summary |

### Diff workflow

1. Model proposes changes through `fs.propose_patch`.
2. Daemon validates patch applies cleanly to current file contents.
3. UI renders proposal in Monaco.
4. User can:
   - Apply full proposal.
   - Reject proposal.
   - Comment on a hunk.
   - Ask for revision.
   - Open touched file in IDE.
5. Apply writes to disk and records a `review_events` row.

For PoV, hunk-level approve/reject can come after full-proposal apply/reject. Do the simple version first, but store the schema in a way that allows hunk-level data later.

## 9. IDE Integration

Developer preference should be project-level and easy to change.

```text
Project Settings
  Preferred IDE:
    - Auto
    - VS Code
    - Visual Studio
    - CLion
    - Custom command
```

### VS Code

Open project:

```powershell
code "C:\path\to\project"
```

Open file at line:

```powershell
code -g "C:\path\to\project\src\file.ts:42"
```

VS Code documents `-g` / `--goto` for `file:line[:character]`.

### CLion

Open project:

```powershell
clion "C:\path\to\project"
```

Open file:

```powershell
clion "C:\path\to\project\src\main.cpp"
```

CLion's command-line launcher opens files or directories. Line-specific opening is less consistent across JetBrains launchers, so the PoV should support file opening first and add line navigation through a custom URI/launcher only after testing on the developer's installed version.

### Visual Studio

Open solution or project:

```powershell
devenv "C:\path\to\project\MySolution.sln"
```

Open file:

```powershell
devenv "C:\path\to\project\src\File.cs"
```

Visual Studio line-specific navigation from command line is not as clean as VS Code. For PoV, open the solution/folder and file. Later, add a small Visual Studio extension or DTE-based helper if exact line navigation is required.

### IDE discovery

On Windows, discover IDEs in this order:

1. User-configured custom command.
2. PATH lookup: `code`, `devenv`, `clion`.
3. Common install paths.
4. JetBrains Toolbox manifests for CLion.
5. Visual Studio Installer `vswhere.exe`.

The daemon owns this through an `IdeLauncher` abstraction:

```rust
trait IdeLauncher {
    fn detect(&self) -> Vec<IdeInstall>;
    async fn open_project(&self, project_root: &Path) -> Result<()>;
    async fn open_file(&self, project_root: &Path, file: &Path, line: Option<u32>) -> Result<()>;
}
```

## 10. Agent Loop

The loop should be bounded and deterministic.

```text
1. User sends task.
2. Daemon creates turn row in SQLite.
3. Daemon assembles context from project card, git state, active files, and retrieval.
4. Daemon sends chat request to LM Studio with tool schemas.
5. If Gemma requests a tool:
   a. Validate tool name and args.
   b. Ask approval if required.
   c. Execute in daemon.
   d. Log result.
   e. Return tool result to Gemma.
6. Repeat up to max tool rounds.
7. Require final answer to include either:
   a. a patch proposal, or
   b. a clear "no change needed" explanation.
8. UI renders final trace and proposal.
```

Initial bounds:

```text
max_tool_rounds: 12
max_shell_seconds: 30
max_files_per_turn: 20
max_patch_files: 8
max_tool_output_to_model: 4000 chars before summarization
```

These limits keep Gemma from wandering and make failures readable.

## 11. UI Design Requirements

The PoV should look like a serious local developer tool, not a landing page.

### Layout

```text
Top bar:
  project selector, model status, index status, preferred IDE, settings

Left rail:
  sessions and recent tasks

Main center:
  chat/task stream or diff view tab

Right panel:
  tool timeline, context used, trace details

Bottom status:
  LM Studio connection, daemon status, SQLite path, vector DB health
```

### Visual behavior

- The diff view is the hero of the app.
- Tool calls should feel like an audit trail.
- The user should always know whether Gemma is thinking, calling a tool, waiting for approval, or done.
- Indexing should be visible but not intrusive.
- Every file path in the UI should have "Open in IDE" and "Reveal in Explorer" actions.

## 12. Packaging

Installer contents:

```text
Aegis.exe / Aegis.app
Rust daemon binary
SQLite migrations
LanceDB runtime dependencies
tree-sitter grammars
default prompts
tool schemas
optional bundled embedding model
```

Do not bundle Gemma weights in the app installer for the first PoV. Let LM Studio own model download and GPU/runtime configuration. The Aegis installer should detect LM Studio and show setup instructions if the local server is unavailable.

First-run checklist:

1. Check daemon starts.
2. Check LM Studio server at `localhost:1234`.
3. List models.
4. Confirm Gemma is loaded.
5. Check embeddings endpoint or mark semantic indexing unavailable.
6. Add first project.
7. Run initial lexical index immediately.
8. Run semantic indexing in the background.

## 13. Build Phases

### Phase 0: Local connectivity spike, 1 day

Deliverable: daemon can call LM Studio and stream a Gemma response.

Tasks:

- Create Rust daemon skeleton.
- Implement `LmStudioClient`.
- Call `/v1/models`.
- Send one chat request.
- Record a session and turn in SQLite.

Exit criteria:

- A CLI command prints model list and a response from Gemma.
- SQLite contains the trace.

### Phase 1: Electron shell and daemon bridge, 2-3 days

Deliverable: desktop app can send a task to the daemon and stream the answer.

Tasks:

- Create Electron + React app.
- Spawn daemon from Electron main.
- Connect renderer to daemon over localhost WebSocket.
- Show chat stream and daemon/model status.

Exit criteria:

- User can type a task and see a streamed Gemma response.

### Phase 2: Tool loop, 3-5 days

Deliverable: Gemma can read files and propose a patch through daemon tools.

Tasks:

- Implement tool schema injection.
- Implement `fs.read`, `fs.list`, `git.status`, `git.diff`.
- Implement `fs.propose_patch`.
- Add fallback JSON parser and repair loop.
- Log all tool calls to SQLite.

Exit criteria:

- User asks "summarize this project" and Gemma calls tools.
- User asks "change this text" and receives a validated patch proposal.

### Phase 3: Diff review UI, 4-5 days

Deliverable: Aegis shows what changed and can apply it.

Tasks:

- Add Monaco diff viewer.
- Store proposals in SQLite.
- Implement patch validation.
- Implement Apply and Discard.
- Add "Open in IDE" per changed file.

Exit criteria:

- A real file change can be proposed, reviewed, applied, and opened in the preferred IDE.

### Phase 4: Project indexing and vector search, 5-7 days

Deliverable: Aegis retrieves project context automatically.

Tasks:

- Implement project registry.
- Add file walker and `.gitignore` support.
- Add tree-sitter chunking.
- Add LanceDB per-project storage.
- Add embedding provider.
- Add `vector.search` tool.
- Show retrieved chunks in UI.

Exit criteria:

- User can ask about a symbol without naming the file, and retrieved chunks appear in the trace.

### Phase 5: IDE polish and developer preference, 2-3 days

Deliverable: IDE handoff feels native.

Tasks:

- Add IDE preference UI.
- Implement VS Code launcher.
- Implement Visual Studio launcher.
- Implement CLion launcher.
- Add custom command template:

```text
{ide} {project} {file} {line}
```

Exit criteria:

- Each changed file has an "Open in IDE" action.
- VS Code opens at the exact line.
- Visual Studio and CLion open the correct project/file.

### Phase 6: PoV hardening, 3-5 days

Deliverable: demo-ready local coding agent.

Tasks:

- Add health panel.
- Add trace export as JSON.
- Add max tool rounds and cancellation.
- Add command approval modal.
- Add log viewer.
- Add model/runtime troubleshooting screen.
- Add 10 local eval tasks.

Exit criteria:

- A 10 minute demo can show indexing, tool calls, patch proposal, diff review, IDE handoff, and trace logs.

## 14. Demo Script

Use a small repo with a failing test or a deliberately simple bug.

1. Launch LM Studio with Gemma loaded.
2. Launch Aegis.
3. Add the project folder.
4. Wait for lexical index, let semantic index continue in background.
5. Ask: "Find why this test fails and propose a minimal fix."
6. Approve `shell.exec` to run the test.
7. Watch Gemma read files and use retrieval.
8. Show the proposed diff.
9. Click "Open in VS Code" on the changed file.
10. Return to Aegis and apply the patch.
11. Re-run the test.
12. Open the trace panel and show every tool call and patch event.

This proves the local loop. It does not need to prove the final server product yet.

## 15. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Gemma emits malformed tool calls | Fallback parser, repair turn, strict max retries |
| Gemma is weaker than Qwen on coding | Keep model client generic and run bakeoff later |
| Embeddings unavailable in LM Studio | Lexical fallback plus optional bundled ONNX embedding model |
| Vector indexing is slow | Lexical index first, semantic index in background |
| Visual Studio line navigation is weak | Open solution/file first; add helper extension later |
| CLion line navigation varies | File/project opening in PoV; exact line after testing installed launcher |
| Shell tools can be risky | Approval modal, workspace cwd, timeout, no direct writes |
| UI becomes too broad | Keep the diff and trace as the primary surfaces |

## 16. Success Criteria

The PoV succeeds when:

- Aegis can connect to LM Studio and use Gemma locally.
- The daemon logs sessions, turns, tool calls, and proposals to SQLite.
- A project can be indexed locally.
- Retrieval changes the context Gemma sees.
- Gemma can call at least `fs.read`, `git.status`, `shell.exec`, and `fs.propose_patch`.
- The UI shows a readable tool timeline.
- The UI shows a polished diff.
- The user can apply or discard a patch.
- The user can open changed files in VS Code, Visual Studio, or CLion based on preference.
- A demo task completes end to end with no server dependency.

## 17. Sources

- [LM Studio Developer Docs](https://lmstudio.ai/docs/developer)
- [LM Studio OpenAI Compatibility Endpoints](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio Tool Use](https://lmstudio.ai/docs/developer/openai-compat/tools)
- [Gemma 4 E4B-it on Hugging Face](https://huggingface.co/google/gemma-4-E4B-it)
- [VS Code command-line interface](https://code.visualstudio.com/docs/editor/command-line)
- [CLion command-line interface](https://www.jetbrains.com/help/clion/working-with-the-ide-features-from-command-line.html)
- [Visual Studio devenv command-line switches](https://learn.microsoft.com/en-us/visualstudio/ide/reference/devenv-command-line-switches)
- [LanceDB Rust SDK](https://docs.rs/lancedb)
- [SQLite vec1 extension](https://sqlite.org/vec1)
