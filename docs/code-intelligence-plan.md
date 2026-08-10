# Code intelligence plan — a native workspace graph for Umbratic

Status: proposal v2 (2026-08-10). Supersedes v1 after review. Source analysis: the
vendored third-party MIT project in `code-review-graph/` (techniques only — no
dependency is taken) and a full audit of the current Umbratic tree.

**This document is self-contained.** The implementer will NOT have access to the
analyzed third-party repository. Every adopted technique is therefore specified in
full — algorithms, data structures, tables, and formulas — in **Appendix A**. The
only external references an implementer needs are files inside the Umbratic repo
itself (the fixture `packages/runner/tests/fixtures/workspace-graph/graph-v1.json`
is the canonical artifact example, and `workspace_graph.rs` is the authoritative
schema).

**Beta context:** Umbratic is pre-production (first beta testing). Nothing here needs
migration paths or backward compatibility with deployed versions. The no-versioning /
tolerant-reader discipline still governs *what we ship*, but we are free to change
schemas, events, prompts, and default skills now.

**What this delivers, in one sentence:** a map of the workspace's code (functions,
classes, who-calls-what, what-tests-what) built silently in the background, which
(a) lets the model answer structural questions in one cheap tool call instead of
grep-and-read chains, and (b) orders the review panel so the highest-priority file
is always first.

---

## 1. Phase 0 — dormant-surface audit and cleanup (do this first)

Audit result (2026-08-10): the codebase is clean of TODO/FIXME debris. Exactly one
"designed but never implemented" feature exists — the workspace graph consumer —
plus two dead appendages on it. Per the principle that schema documenting intent
rather than behavior is a standing lie, every item below gets an explicit decision:

| Surface | State | Decision |
|---|---|---|
| `packages/runner/src/workspace_graph.rs` + its full consumer stack (catalog entry `catalog.rs:381`, config parsing `config.rs:562`, session service `session.rs:220`, dispatch `dispatch.rs:217`, surface gate `surface.rs:111`, request parsing `request.rs:117`) | Complete, tested, **dormant** — desktop never sends `workspaceGraph`, no producer exists | **Activate** (Phases 1–3). This plan is the producer it was waiting for. If this plan is ever abandoned instead, delete the entire stack — do not leave it dormant again. |
| `GraphNode.community_id` (`workspace_graph.rs:37`) | Write-only: accepted by the schema, read by nothing | **Remove now.** Communities are explicitly out of scope (§8); re-add the field if that ever changes. |
| `packages/runner/tests/fixtures/workspace-graph/` — `graph-v1.json`, `evaluation-tasks.json`, language fixtures (ts/py/go/mixed) | Referenced by **zero tests**; aspirational acceptance criteria with no harness | **Keep and wire into real tests** in Phase 1 (they become the producer's acceptance suite). Anything still unreferenced at the end of Phase 1 gets deleted. |
| Desktop gaps: `workspace_graph` absent from `types.ts:10` / `toolSettings.ts:3`, no policy assertion, no config key, no capability entry | The four missing wiring steps | **Wire** in Phase 1. |
| `commandDisplay.ts:54` ("Inspect code") and the tool-kind list in `renderer-markdown.test.ts:727` | Harmless consumer-side rendering | Keep; becomes live with Phase 1. |
| `no-versioning-guard.test.ts:57` exemption for `workspace_graph.rs` | Valid — the file's test asserts versioned graphs are rejected | Keep. |

Also in Phase 0, one consistency guard this audit showed we lack: a parity test
asserting the desktop's `runnerToolIds` list is a subset of the runner's known tool
ids (`config.rs:13-23`), so a tool can never again exist on one side of the
boundary without an explicit decision on the other. (The catalog's larger set —
`apply_patch`, `read_skill`, `retrieve_context`, etc. — is intentionally
non-user-toggleable; the test documents that.)

## 2. Design principles (applied throughout)

1. **Fail toward absence.** Every failure mode — missing artifact, crashed parser,
   stale graph, oversized workspace — degrades to exactly today's behavior. The
   worst outcome of any bug in this feature is "the feature is absent," never "the
   harness is broken." The runner's existing degraded-mode text already implements
   this; the producer and desktop must preserve it.
2. **One source of truth per fact.** Tool schema and validator generate from the
   same catalog entry (already true). The risk ordering shown to the user and the
   ordering given to the model come from the same insights file. No fact is
   computed twice in two places.
3. **Deterministic outputs.** Same tree → byte-identical artifact, on every OS.
   Sorted ids, POSIX paths, no timestamps in identity.
4. **Evidence, not authority.** Graph answers are labeled evidence with confidence
   tiers; ambiguous edges are never traversed; every response keeps the existing
   "verify with read" framing. Truncation always discloses itself.
5. **No dead schema.** Every field shipped has a reader. (Phase 0 enforces this
   retroactively; review enforces it going forward.)
6. **Untrusted input everywhere.** Workspace source is untrusted (it can contain
   adversarial identifiers aimed at the model); the artifact is untrusted until the
   runner re-validates it; the parser runs in an isolated one-shot process.

## 3. Architecture (unchanged from v1, condensed)

New workspace crate **`packages/code-index/`** (lib + `[[bin]] umbratic-code-index`),
mirroring `packages/pdf` (one-line `Cargo.toml` members addition; bundled with the
desktop like `umbratic-desktop-core`). Tree-sitter plus eight grammar crates —
**TypeScript/TSX, JavaScript, Python, Go, Rust, C, C#, CMake** — statically linked
into a **non-networked one-shot binary** whose only output is the JSON artifact the
runner already validates (`deny_unknown_fields`, path normalization, control-char
rejection, ≤32 MiB). Grammar crashes therefore cost an index build, never a session.

### 3.1 Dependency validation (crates.io, checked 2026-08-10)

| Crate | Pin | Published | Maintainer | License |
|---|---|---|---|---|
| `tree-sitter` (core) | **0.26.11** | 2026-07-12 | tree-sitter org | MIT |
| `tree-sitter-language` (ABI shim) | 0.1.7 | 2026-02-01 | tree-sitter org | MIT |
| `tree-sitter-typescript` (TS + TSX) | 0.23.2 | 2024-11-11 | tree-sitter org | MIT |
| `tree-sitter-javascript` | 0.25.0 | 2025-09-01 | tree-sitter org | MIT |
| `tree-sitter-python` | 0.25.0 | 2025-09-11 | tree-sitter org | MIT |
| `tree-sitter-go` | 0.25.0 | 2025-08-29 | tree-sitter org | MIT |
| `tree-sitter-rust` | 0.24.2 | 2026-03-27 | tree-sitter org | MIT |
| `tree-sitter-c` | 0.24.2 | 2026-04-22 | tree-sitter org | MIT |
| `tree-sitter-c-sharp` | 0.23.5 | 2026-04-14 | tree-sitter org | MIT |
| `tree-sitter-cmake` | 0.7.4 | 2026-07-08 | **uyha (community)** | MIT |

Validation notes and required policy changes:

- **Core is pinned to 0.26.11, not the newest 0.26.12** — the latter published
  2026-08-08, inside the 14-day `minimumReleaseAgeDays` cooldown. Grammar crates
  bind through the version-stable `tree-sitter-language` ABI shim, so mixed grammar
  release dates (0.23.x–0.25.x) are by-design compatible with the 0.26 core.
- **MIT is already on `allowedCargoLicenseExpressions`** — no license change.
- **Every grammar crate plus the core has a `build.rs`** (compiles the generated C
  parser via `cc`), so each needs an `allowedCargoBuildScriptPackages` entry in
  `supply-chain-policy.json`. The dependency PR must include the explicit
  build-script review the policy requires — each grammar `build.rs` is a ~10-line
  `cc::Build` invocation, quick to eyeball.
- **`tree-sitter-cmake` is the one non-org crate** (community maintainer `uyha`,
  the de-facto standard CMake grammar used by Neovim/Helix). Extra scrutiny for
  this one: one-time manual review of its hand-written `scanner.c` at the pinned
  version, and treat any future maintainer change as a review trigger.
- Per-language extraction scope for the additions: **C** — functions/structs/enums,
  `#include "…"` resolved relative-only (system includes stay external; `.h` files
  parse as C since C++ is out of scope); **C#** — namespaces/classes/interfaces/
  methods, `using` namespace imports resolved via the namespace→declaring-files
  index; **CMake** — functions/macros/targets (`add_executable`/`add_library`
  names) as symbols, `include()`/`add_subdirectory()` as imports,
  `target_link_libraries` as `depends` edges — which makes build wiring visible to
  the graph, a natural fit for the `umbratic-cmake` skill's users; **JavaScript** —
  same tables as TS minus type nodes.

```
desktop main (indexerService.ts)
  └─ spawns: umbratic-code-index build --workspace <path> --out .umbratic/index/graph.json
runner config += workspaceGraph: { artifactPath }        (parsed today at config.rs:562)
  └─ workspace_graph tool admits → model queries the map
```

- Artifact at `.umbratic/index/graph.json`; add `index/` to the generated-path
  exclusions (`policy.rs:35`) so `search`/`find`/`ls` skip it.
- Build on workspace open (background, never blocking — until the artifact exists
  the tool simply doesn't admit); hash-diff incremental update after each settled
  turn, alongside `refreshReview` (`taskRunner.ts:466-483`).
- Extraction: dict-driven node-type tables per language driving one generic walker
  (**Appendix A1**); read-once/hash-once `parse_bytes` (**A2**); POSIX path
  identity; node ids per the existing fixture scheme (`file:<path>`,
  `symbol:<path>:<kind>:<name>:<line>`); `tested_by` edges mirrored from calls
  originating in test files (**A4**); labels sanitized (**A8**) — names and
  locations only, never file contents, so nothing secret-shaped can enter the
  artifact.
- Resolution is evidence-gated onto the schema's existing confidence enum
  (**A3**): same-file match → `extracted`; resolved through exactly one imported
  file → `inferred`; multiple candidates or unresolved → `ambiguous` (kept,
  labeled, never traversed). A globally unique name is not sufficient evidence.
- Incremental updates per **A6**: `git diff --name-status -z` from the recorded
  revision (renames purge the old path); unresolvable base → full rebuild, never a
  wrong-base diff; whole-file node/edge replacement; stale-file reconciliation.

## 4. Phase 1 — producer, wiring, and steering (one phase, shipped together)

v1 deferred prompt/steering work to a later phase. That was wrong: **the schema
being correct is already guaranteed by the catalog** (schema and validator from one
`ToolDefinition`; surface frozen per task; typed `ContractViolation` + 2 repair
rounds for malformed calls). The open risk is *when and how* small local models use
the tool — so the steering ships in the same phase as the tool, and the tool is
never live without it.

### 4.1 Producer + wiring

1. `packages/code-index` crate as in §3, with `build` and `update` subcommands.
2. Desktop wiring, mirroring the LSP pattern: add `"workspace_graph"` to
   `types.ts:10` + `toolSettings.ts:3`; presence check for the bundled binary in
   `capabilities.ts`; policy assertions in `policy.ts` (never enabled without an
   artifact path; artifact path inside the workspace); `indexerService.ts` owns
   build scheduling and adds `workspaceGraph: { artifactPath }` to the runner
   config when the artifact exists.
3. Remove `community_id`; wire the orphan fixtures into tests (Phase 0 decisions).

### 4.2 Steering — three layers, cheapest first

1. **Tool description (harness-side, always in context when the tool admits).**
   The catalog already computes per-session prose for `command`/`run_program`
   descriptions at surface-build time; `workspace_graph` gets the same treatment —
   a compact decision procedure in ~4 lines: *"Map of this workspace's code. Start
   with `summary`. Use `affected` for blast-radius questions, `query` for
   callers/definitions, `changes` when reviewing. Results are evidence with
   file:line locations — verify with read before editing."* This is the primary
   steering channel and ships with the harness.
2. **Bucket playbooks (Veil-side — free to change in beta).** Veil receives the
   request's `tools` array, so playbook assembly renders graph guidance **only when
   the tool is present** (same conditional pattern as `RelevantSkills`). One or two
   imperative lines per bucket in `buckets.go`, no more:
   - `repo_orient`: graph `summary` before broad `ls`/`search` sweeps.
   - `code_explain` / `debug_failure`: locate the symbol, then `query` its callers
     before grepping.
   - `code_change` / `refactor_migrate`: before editing a shared symbol, `affected`
     to see what depends on it.
   - `review_audit` / `deep_review`: `changes` first; read only the
     highest-priority symbols it names; do **not** re-read files the diff didn't
     touch. (Explicit negative instructions are what actually shorten tool chains.)
3. **Skills (default set updated).** `umbratic-security-review` (already in the
   engineering default set, `skills.ts:92-102`) gets a routing update: check the
   graph's security-relevant changed symbols before manual grep sweeps. **No new
   skill is added** — a dedicated graph skill would duplicate layers 1–2, and the
   default skill sets otherwise stay as they are.

### 4.3 Phase 1 gates

- The four `evaluation-tasks.json` questions pass through real tool dispatch
  against artifacts produced from the language fixtures — including the
  honest-no-answer question ("Where is billing implemented?" → empty). New
  fixtures added for the languages the existing set lacks: `javascript/`, `c/`,
  `csharp/`, `cmake/` (the current fixtures cover only ts/py/go/mixed).
- Determinism: double build byte-identical; Windows/POSIX path identity test.
- Performance: initial build ≤5s for a 5k-file synthetic tree; incremental update
  ≤300ms for a single-file change (gate modeled on `search_performance.rs`).
- Tool-id parity test from Phase 0; `npm run test:all` green.

## 5. Phase 2 — make `affected` mean something

Replace `affected`'s flat BFS with depth-bounded max-product scoring over the
in-memory `GraphIndex` (no storage change):

```
score(seed) = 1.0
score(v)    = max over edges (u→v) of score(u) × weight(relation) × confidence × 0.6
prune ≤ 0.05 · depth default 2 (≤ existing MAX_GRAPH_DEPTH 8) · deterministic id tie-break
```

Weights: `calls` 1.0 · `inherits`/`implements` 0.9 · `tested_by` 0.7 (traversed
forward; stored production→test) · `references` 0.6 · `imports` 0.5 · `contains`
never traversed (a changed file seeds its symbols instead). Confidence:
`extracted` 1.0, `inferred` 0.8, `ambiguous` excluded. `nodes[]` gains a `score`
field; envelope shape otherwise unchanged. Full algorithm with pseudocode and the
direction table in **Appendix A5**. The numbers are documented starting points to
be tuned by the Phase 4 eval, not inherited truths.

## 6. Phase 3 — review priority

### 6.1 What the user sees (deliberately minimal)

The review panel file list is **ordered by review priority, highest first**, with a
single quiet caption: *"Ordered by review priority."* No badges, no scores, no
factor breakdowns, no test-gap chips — the user should not need to care how the
ordering is computed, only that the first file is the one to look at first. Falls
back to today's path ordering when insights are unavailable. (A "by path" sort
toggle stays, since alphabetical is genuinely useful when scanning for a known
file.)

### 6.2 How it's computed (internal)

`umbratic-code-index analyze --workspace <path> --base <commit>` writes
`.umbratic/index/insights.json` — sibling to the graph, **no new config key**; the
runner and desktop both find it by convention next to `artifactPath`:

```jsonc
{
  "patchHash": "…",              // matches reviewPatchHash — insights always describe the diff being shown
  "overallRisk": 0.72,           // max over symbols, not mean: one dangerous change makes the diff dangerous
  "fileOrder": ["src/auth.ts", …],
  "symbols": [ { "id", "label", "path", "line", "risk", "tested" } ],
  "testGaps": [ …ids ]
}
```

Per changed symbol, three factors (v1 had five; churn and community terms are cut —
fewer knobs, no extra git archaeology):

```
risk = 0.40 × (1 − min(tests/3, 1))          // untested code is the dominant signal
     + 0.35 × min(callers + dependent_files, 15)/15   // how widely a mistake propagates
     + 0.25 × security_name                   // label/qualified-name contains auth|token|crypt|sql|exec|…
```

Changed lines map to symbols by interval overlap from `git diff --unified=0`
hunk headers (exact parsing rules in **Appendix A7**; the security-keyword list is
in **A7.3**). Desktop: `reviewInsights.ts` runs `analyze` after `refreshReview`,
keyed on `reviewPatchHash` (skip when unchanged); `review.ready` carries a sibling
`insights` field. Telemetry continues to export only `{fileCount, additions,
deletions}` — insights never enter the bundle (golden fixture guards it).

### 6.3 What the model sees

New `changes` action on `workspace_graph`, reading the same insights file — one
source of truth for human ordering and model ordering:

```json
{ "summary": "12 changed symbols, 3 untested", "overallRisk": 0.72,
  "priorities": [ { "label": "validateSession", "path": "src/auth.ts", "line": 41 }, … ] }
```

Names, counts, and locations only — the minimal response is a structurally smaller
object, not a truncated dump. The `review_audit`/`deep_review` playbook lines from
Phase 1 point at it.

## 7. Phase 4 — evaluation gate (lean)

- Wire `evaluation-tasks.json` (extended with review-priority cases) into a
  release-gate doc at `packages/runner/tests/fixtures/workspace-graph/evaluation.md`,
  mirroring the existing LSP rubric (`code-intel/evaluation.md`).
- Honest baseline only: the same questions answered via `search`+`read`
  transcripts, token-counted with the existing estimators — never a
  "read-the-whole-repo" strawman. Every eval row carries a status; failures are
  reported and excluded from aggregates, and the exclusion count is itself
  reported.
- Use the results to tune the §5/§6 constants, then document the tuned numbers as
  measured. **This gate decides whether small local models actually use the tool
  well; if they don't, the steering text is what gets iterated — not more
  machinery.**

## 8. Explicitly not doing

- **Communities and execution flows.** Cut entirely (v1 had them as "phase 5");
  `community_id` is removed in Phase 0. Reconsider only with evidence from real
  usage.
- **Risk math in the UI.** No badges, scores, or factor readouts in the review
  panel — ordering plus one caption is the whole surface.
- **Churn analysis, embeddings, vector search, MCP, rename/refactor tooling, a
  dedicated graph skill, wiki generation.** Same reasons as v1: dependency weight,
  overlap with LSP, or duplicated steering layers.
- **More languages beyond the validated eight.** Notably **C++**: out of scope for
  now — `.h` files parse as C, and `tree-sitter-cpp` (also org-official) is the
  obvious next addition if C users demand it. The dict-driven design makes any
  new language one grammar crate + four lists when usage justifies the
  supply-chain review.

## 9. Risks and open decisions

1. **Supply chain:** validated 2026-08-10 (§3.1) — ten pinned MIT crates, seven
   grammars org-official, CMake the one community-maintained exception (gets a
   `scanner.c` review). All C code compiles into an isolated non-networked helper
   whose output is fully re-validated, so "low and well-contained" is accurate —
   "no risk" is not. Remaining work is mechanical: the dependency PR with
   lockfile, `allowedCargoBuildScriptPackages` entries, build-script review, and
   `supply-chain:check`/`audit` results.
2. **Small-model adoption** is the genuine uncertainty. Mitigated by making one
   call return a complete small answer, three steering layers, and the Phase 4
   gate. If a `llama3.2`-class model still won't use it, the panel ordering
   (model-free) survives on its own merits.
3. **Mid-turn staleness:** after the model edits files, graph answers about them
   are stale-flagged until the between-turn reindex. Bounded, labeled, and the
   fallback is a read the model needed anyway.
4. **Path-exclusion parity** between producer and `policy.rs`: duplicate the lists
   with a parity test first; extract a shared crate only if they start drifting.
5. **Oversized workspaces:** budget nodes (top-level symbols + methods, no
   locals); past the 32 MiB artifact cap, fail toward "no graph" rather than a
   partial lie.

## 10. Order of work

| Step | Scope | Size |
|---|---|---|
| 0 | Cleanup: remove `community_id`, tool-id parity test, fixture decisions | small |
| 1 | `packages/code-index` + 4 wiring steps + 3 steering layers + gates | large (~⅔ of total) |
| 2 | Weighted `affected` in `workspace_graph.rs` | small |
| 3 | `analyze` + insights file + panel ordering + `changes` action | medium |
| 4 | Eval gate + constant tuning | small |

Everything degrades to today's behavior when any piece is missing, which is both
the compat contract's demand and this feature's safety story.

---

# Appendix A — Implementation reference (self-contained)

Everything below is a complete specification; no external repository is needed.
Where a rule sounds oddly specific, it encodes a failure mode the analyzed
project hit in production — those notes are kept inline as "why".

## A1. Extraction: one generic walker + per-language node-type tables

### A1.1 The walker

One recursive descent over the tree-sitter CST, shared by all languages. Node
*type names* (strings from the grammar) are looked up in four per-language sets;
everything language-specific lives in those tables, not in the walker.

```
walk(node, enclosing_class, enclosing_func, depth):
    if depth > MAX_AST_DEPTH (200): return          // pathological trees
    for child in node.children:
        if language_escape_hatch(child): continue    // see A1.3
        t = child.type
        if t in CLASS_TYPES[lang]:
            emit class/type node (kind per table); walk(child.body, name, none, depth+1)
        else if t in FUNCTION_TYPES[lang]:
            emit function node (parent = enclosing_class); walk(body, enclosing_class, name, depth+1)
        else if t in IMPORT_TYPES[lang]:
            handled = extract_import(child)
            if not handled: fall through to call check   // some grammars share one
                                                         // node type for import and call
        else if t in CALL_TYPES[lang]:
            emit call edge from (enclosing_func or enclosing_class or file node)
        else:
            walk(child, enclosing_class, enclosing_func, depth+1)
```

- Enclosing scope is threaded as two plain parameters, never a mutable stack.
- Names come from the grammar's `name` field where present; otherwise probe an
  ordered list of field candidates per language (e.g. `["name", "declarator"]`).
- A node with no resolvable name is skipped, not invented.
- Column/line numbers: tree-sitter is 0-based; the artifact is 1-based
  (`startLine ≥ 1`) — convert once, at emission.

### A1.2 Node-type tables (seed values — verify against the pinned grammars)

These are correct to the best of current knowledge for the §3.1 pins, but grammar
releases occasionally rename node types. **Treat the fixture tests as the source
of truth**: each language fixture asserts the exact symbols extracted; if a table
entry is wrong the test fails and the table gets corrected. Do not skip a language
because a name drifted.

| Lang | CLASS_TYPES (→ kind) | FUNCTION_TYPES | IMPORT_TYPES | CALL_TYPES |
|---|---|---|---|---|
| ts/tsx | `class_declaration`, `abstract_class_declaration`, `interface_declaration` (interface), `enum_declaration` (enum), `type_alias_declaration` (type) | `function_declaration`, `generator_function_declaration`, `method_definition`; plus `variable_declarator` whose value is `arrow_function`/`function_expression` (named function values) | `import_statement`; `export_statement` with a `source` (re-export); `call_expression` on `require` | `call_expression`, `new_expression` |
| js | same minus interface/enum/type_alias | same | same | same |
| python | `class_definition` | `function_definition` (async included; unwrap `decorated_definition`) | `import_statement`, `import_from_statement` | `call` |
| go | `type_declaration` → per inner `type_spec`: struct/interface/type | `function_declaration`, `method_declaration` (receiver type → parent) | `import_declaration` (each `import_spec`) | `call_expression` |
| rust | `struct_item`, `enum_item`, `trait_item`, `union_item` | `function_item` (inside `impl_item`: parent = impl target type) | `use_declaration` | `call_expression` (incl. method calls via `field_expression`) |
| c | `struct_specifier`, `enum_specifier`, `union_specifier`, `type_definition` | `function_definition` (name is inside the declarator chain — unwrap pointer/function declarators) | `preproc_include` | `call_expression` |
| c# | `class_declaration`, `interface_declaration`, `struct_declaration`, `enum_declaration`, `record_declaration` (namespace from enclosing `namespace_declaration` / `file_scoped_namespace_declaration`) | `method_declaration`, `constructor_declaration`, `local_function_statement` | `using_directive` | `invocation_expression`, `object_creation_expression` |
| cmake | — (targets are commands, see A1.3) | `function_def`, `macro_def` | — (commands, see A1.3) | `normal_command` (an invocation of a user function/macro) |

### A1.3 Language escape hatches (the known irregular cases)

- **CMake:** everything interesting is a `normal_command`; dispatch on the
  lower-cased command identifier: `add_executable`/`add_library` → emit a target
  symbol (first argument = name); `include`/`add_subdirectory` → import edge to
  the referenced file/dir's CMakeLists; `find_package` → external import (stays
  bare); `target_link_libraries` → `depends` edge from the named target; any
  other identifier that matches a known `function_def`/`macro_def` name → call
  edge.
- **Go methods:** `method_declaration` has a receiver; set `parent` to the
  receiver's type name so `(s *Server) Handle` becomes `Server.Handle`.
- **Rust impls:** functions inside `impl_item` take the impl's type as parent;
  trait impls (`impl Trait for Type`) additionally emit an `implements` edge
  Type → Trait.
- **C function names** hide inside nested declarators
  (`pointer_declarator`/`function_declarator`); unwrap until an `identifier`.
- **TS/JS named function values:** `const f = () => {}` — take the name from the
  `variable_declarator`, not the arrow function.
- **Python decorated defs:** unwrap `decorated_definition` to the inner
  `function_definition`/`class_definition`; record decorator names in the edge
  evidence when they resolve a framework pattern.

### A1.4 Node identity and qualified names

```
file node id:    file:<workspace-relative POSIX path>
symbol node id:  symbol:<path>:<kind>:<name>:<startLine>
qualifiedName:   <file stem or declared module/namespace>.<Parent>.<name>
```

`::` never appears inside ids; `.` separates symbol scopes in `qualifiedName`.
Paths are POSIX (`/`) always — the runner's validator rejects `\`, leading `/`,
and `..` components. **Never normalize symbol names the way paths are normalized**
(a C# namespace or Rust path is not a filesystem path).

## A2. Read-once, hash-once, parse-once

The only parsing entry point is `parse_bytes(path, bytes)`:

```
bytes = fs::read(path)                 // exactly one read
hash  = sha256(bytes)
lang  = detect_language(path, &bytes)  // extension first; any content sniffing
                                       // (shebangs etc.) reads bytes, NEVER the file again
(nodes, edges) = extract(lang, &bytes)
artifact.files[path] = { hash, size: bytes.len(), language, indexedAt: now }
```

Why this is strict: language detection that re-opens the file races with a
concurrent save. The stored hash then describes different bytes than the parse —
and because the hash gate (A6) skips unchanged files, the wrong parse is
**permanent**. Every decision must derive from the one buffer.

## A3. Resolution: the three-stage evidence funnel

Calls are extracted with whatever target text the syntax gives (`save`,
`store.save`, `Store::save`). Resolution upgrades those strings to node ids — but
only ever with evidence, and every edge records which tier produced it.

**Stage 1 — same-file (confidence `extracted`).** After walking a file, build
`bare_name → [symbol ids defined in this file]`. Rewrite any call edge whose
target matches exactly one same-file symbol. Multiple matches (overloads): pick
the nearest enclosing scope, else leave for stage 3.

**Stage 2 — import map (confidence `inferred`).** Per file, resolve its import
statements to workspace files:

- *TS/JS relative:* probe `./x` as `x.ts, x.tsx, x.js, x.jsx` then `x/index.*`.
- *TS/JS aliased:* tsconfig resolution, spec in A3.1.
- *Python:* `a.b.c` → `a/b/c.py` or `a/b/c/__init__.py`, probing from the
  importing file's directory upward to the workspace root.
- *Go:* module path from `go.mod`; an import whose prefix matches the module
  maps the remainder to a directory; edge targets the package's files.
- *Rust:* `mod x;` → `x.rs` / `x/mod.rs`; `use crate::a::b` → walk the module
  tree from `src/lib.rs`/`src/main.rs`.
- *C:* `#include "x.h"` relative to the including file only; `<x.h>` stays
  external.
- *C#:* `using N.S;` imports a **namespace**, not a file — consumed by stage 3's
  namespace index, not resolved here.
- *CMake:* `add_subdirectory(d)` → `d/CMakeLists.txt`; `include(f)` → `f.cmake`
  probes.

A call whose receiver/name is exported by **exactly one** file this file imports
→ rewrite to that symbol, `confidence: "inferred"`, evidence names the import
(e.g. `"resolved through import of src/store.ts"`).

**Stage 3 — global pass (rewrites to `inferred`, or labels `ambiguous`).** After
all files are parsed, build three indexes in one pass each:

```
by_name:    bare name        → [(symbol id, defining file)]
imports_of: file             → set of files it imports (from stage-2 results)
by_ns:      namespace (C#)   → set of files declaring it
```

For each still-unresolved call edge from file F targeting name N:
- candidates = `by_name[N]` filtered to: defined in F, or in `imports_of[F]`,
  or (C#) in a file of a namespace F `using`s.
- **exactly 1** → rewrite target to it, `confidence: "inferred"`, keep the
  original text in `evidence` (makes the pass idempotent and auditable).
- **> 1** → leave target as the bare string, `confidence: "ambiguous"`,
  `evidence: "N candidates: a.ts, b.ts, …"` (cap the list at 5).
- **0** → leave bare, `confidence: "ambiguous"`, `evidence: "unresolved external call"`.

**The rule that makes this honest:** a globally unique name is *not* sufficient
evidence — unrelated code often contains one same-named helper by coincidence.
Without file-or-import evidence, the edge stays ambiguous. Consumers (A5) never
traverse ambiguous edges; they exist so `explain` can show them.

### A3.1 tsconfig path-alias resolution

1. From the importing file's directory, walk upward; at each level probe
   `tsconfig.json`, then `tsconfig.app.json`, then `jsconfig.json` (first hit
   wins). Memoize per-directory, **including negative results**.
2. Parse as JSONC: strip `//` and `/* */` comments with a scanner that is
   string-literal-aware and escape-aware (a naive regex corrupts URLs in
   strings); then remove trailing commas.
3. Follow the `extends` chain recursively with a visited-set for cycles; child
   `compilerOptions.paths`/`baseUrl` override parent.
4. Match the import against `paths` patterns **sorted by specificity** = length
   of the pattern's prefix before `*`, descending — so `@app/utils/*` beats
   `@app/*`.
5. Substitute the `*` capture into each target, resolve against `baseUrl`, probe
   `.ts/.tsx/.js/.jsx` then `index.*`. First existing file wins.

## A4. `tested_by` mirroring

No separate analysis pass. During emission, for every `calls` edge whose source
symbol lives in a test file, *also* emit:

```
{ relation: "tested_by", from: <callee id>, to: <test symbol id>,
  confidence: <same as the calls edge>, evidence: "mirrored from test call site" }
```

Direction is deliberately production→test: "what tests cover X" — the query that
matters for review — becomes a direct outgoing-edge lookup on X.

Test-file detection per language: ts/js `*.test.*`, `*.spec.*`, `__tests__/`;
python `test_*.py`, `*_test.py`, `tests/`; go `*_test.go`; rust symbols inside a
`#[cfg(test)]` module or files under `tests/`; c# file or class name ending
`Test`/`Tests`; c/cmake: none at launch.

## A5. Weighted impact traversal (Phase 2)

Relations are stored dependent→dependency (caller→callee, importer→imported),
**except** `tested_by` (production→test). "Impact of changing X" therefore flows
*against* most arrows. Encode that as a direction table, not as code:

```
WEIGHT    = { calls:1.0, inherits:0.9, implements:0.9, tested_by:0.7,
              references:0.6, imports:0.5, depends:0.6 }        // default 0.5
DIRECTION = { tested_by: Outgoing, contains: Never, _: Incoming }
DECAY = 0.6   FLOOR = 0.05   DEFAULT_DEPTH = 2   MAX_NODES = 40 (existing envelope cap)
CONF  = { extracted:1.0, inferred:0.8, ambiguous: skip edge entirely }
```

```
best     = { seed: 1.0 for each seed }        // a changed file seeds all its symbols
frontier = best.clone()
for hop in 1..=depth:
    next = {}
    for (u, score_u) in frontier:
        for edge adjacent to u where admissible(edge.relation, direction relative to u):
            v = the other endpoint
            s = score_u * WEIGHT[rel] * CONF[edge.confidence] * DECAY
            if s > FLOOR and s > next.get(v): next[v] = s
    retain next[v] only where s > best.get(v)
    if next.empty(): break
    best.merge_max(next); frontier = next
result: nodes sorted by (score desc, id asc), truncated to MAX_NODES with
        truncation.omitted = true when cut
```

Why max-product with one-best-score-per-node instead of path enumeration: cyclic
graphs have exponentially many paths; this map holds at most one entry per node
and each hop is one scan of the adjacency lists. Why `contains` is never
traversed: a changed file already seeds every symbol in it, and following
containment bridges into unrelated structure through the file node.

## A6. Incremental update

```
recorded = artifact.revision                      // git commit of last build
if !git_ref_resolves(recorded): full rebuild      // rebase/shallow clone — never
                                                  // diff against a wrong base
changed = git diff --name-status -z <recorded>    // NUL-separated
```

- Parse `-z` records field-wise: `R…`/`C…` (rename/copy) records carry **two**
  paths — old and new. The old path must enter the purge set or its nodes leak.
- Validate any ref before passing to git: must match `^[A-Za-z0-9_.~^/@{}\-]+$`
  and not start with `-` (argument injection). Argv arrays only, no shell.
- Per surviving file: read+hash (A2); **skip if hash equals the stored one**
  (git reports touched-but-identical files); else re-parse and do **whole-file
  replacement** — delete every node and edge whose source file is this file,
  insert the fresh set. Never patch at node granularity.
- Purge set: deleted/renamed-away paths → remove their nodes, plus *all* edges
  referencing those nodes (not just edges sourced in the file).
- Reconcile: any file present in `artifact.files` but no longer on disk or now
  excluded → purge. Then re-run stage 3 (A3) — cheap, it's index lookups.
- Re-sort nodes and edges by id; rewrite the artifact atomically (temp file in
  the same directory + rename).

## A7. Change analysis (Phase 3 `analyze`)

### A7.1 Diff → changed line ranges

```
git diff --unified=0 <base> --        // zero context = ranges are EXACTLY the changed lines
file:  ^\+\+\+ b/(.+)$
hunk:  ^@@ .+? \+(\d+)(?:,(\d+))? @@
```

Missing count = 1. A count of **0** (pure deletion) collapses to `(start, start)`
so the deletion position still maps to the symbol it happened in.

### A7.2 Ranges → symbols

Interval overlap, inclusive: symbol S in file F is changed iff
`S.startLine <= range.end && S.endLine >= range.start`. Dedupe by id.

### A7.3 Risk

Per changed symbol (formula also in §6.2):

```
risk = 0.40 × (1 − min(tested_by_count / 3, 1))
     + 0.35 × min(caller_count + dependent_file_count, 15) / 15
     + 0.25 × security_name
```

`security_name` = 1 iff the lower-cased label or qualifiedName contains any of:

```
auth login password token session crypt secret credential permission
sql query execute connect socket request http sanitize validate
encrypt decrypt hash sign verify admin privilege
```

Substring match, deliberately high-recall (`execute` matches `executeBatch`).
`overallRisk = max(symbol risks)` — never the mean; one dangerous change makes
the diff dangerous. File order = files sorted by their max symbol risk desc,
ties by path asc. Thresholds where needed: ≥0.85 critical, ≥0.7 high, ≥0.4
medium.

## A8. Sanitization and response shaping

- **Every string emitted into the artifact or a tool response**: strip control
  characters (keep `\t`, `\n` only where the field is multi-line), cap labels at
  256 chars, evidence at 256 chars. Source code is untrusted input to a model —
  an identifier can literally be crafted as a prompt injection. The length cap
  matters as much as the control-char strip. The runner's validator is the
  second, independent layer.
- **Minimal responses are smaller objects, not truncated dumps**: the `changes`
  action returns names/counts/locations, never source text or full edge lists.
- **Every truncation self-reports** (`truncation.omitted`, counts) — already the
  envelope's convention; keep it in every new action.
- **Empty fields are omitted entirely**, never sent as `[]`/`null` noise.

## A9. Determinism requirements (tested, not aspirational)

1. Two builds of an unchanged tree → **byte-identical** artifacts. Consequences:
   nodes/edges sorted by id; `files` map serialized with sorted keys;
   `builtAt`/`indexedAt` are the only timestamp fields and are **excluded** from
   the byte-comparison test (rewrite to fixed values before comparing).
2. Windows and POSIX builds of the same tree → identical ids and paths.
3. Any iteration order that reaches the output goes through a sort — no HashMap
   iteration order in emitted data.
4. The eval and fixtures pin everything stochastic (there should be nothing
   stochastic; if something creeps in, seed it).
