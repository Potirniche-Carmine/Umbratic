---
title: Umbratic Unified Harness Blueprint
tags:
  - umbratic
  - harness
  - implementation-plan
status: draft
aliases:
  - Unified Harness Blueprint
---

# Umbratic Unified Harness Blueprint

This is the simple status view for the new `UmbraticAI/` repo after comparing it against the prior implementation thread and the Umbratic/reference implementation/Hermes/Osaurus notes.

The goal is not to copy every reference implementation, Hermes, or Osaurus feature. The goal is to keep Umbratic private, local-first, small in the model prompt, and reliable at tool use.

Concrete source examples are in [[Umbratic Implementation References]].

## What Umbratic Is

Umbratic should be a private AI workbench for local and company-managed model infrastructure.

It should focus on:

- Local workspace tools.
- Local skills.
- Veil as the private model boundary.
- Small model-visible tool schemas.
- Mode-aware system skills.
- Worktree review and approval.
- Local/private document artifact workflows.
- Server-managed artifact templates that Veil can see and select when relevant.
- Redacted telemetry for managed company deployments.

It should not become a public connector platform, generic internet agent, public skill marketplace, or public model marketplace.

## Already Done In `UmbraticAI/`

### Product Boundary

- Veil is the model boundary.
- The desktop routes through engineering, marketing, or sales chat endpoints.
- `company-endpoint` is the only provider path.
- Direct public provider passthrough is not present.
- Browser automation, web search, MCP, public connectors, and public marketplaces are not active product surfaces.

### Runner Tools

- Debugger tooling is removed.
- The runner tool list is small:
  - `read`
  - `search`
  - `write`
  - `edit`
  - `command`
- Tool schemas are compact and stable.
- Partial streamed tool-call arguments are accumulated.
- Tool results carry structured status, error code, error message, exit code, and duration.
- Command policy classifies risky commands such as network commands, external paths, destructive file actions, package-manager writes, bare Python, Git writes, and shell commands.

### Modes And Skills

- Engineering mode can receive workspace, Git, worktree, Python, CMake, and Markdown runtime guidance.
- Marketing and sales avoid engineering-only runtime guidance by default.
- Markdown remains available across modes when the task is Markdown-shaped.
- System skills are visible in Skills settings, toggleable, and editable.
- System skills materialize as editable files under `~/.umbratic/skills/system/<id>/SKILL.md`; personal skills remain editable under `~/.umbratic/skills`.
- Local skills are compact by default and only expand on explicit `$skill` use or strong match.
- System skills cover engineering, Markdown, PDF, DOCX, PPTX, XLSX, marketing, and sales workflows.

### Documents And Attachments

- The desktop supports file attachments.
- Text attachments are clipped into prompt context.
- Image attachments are sent as image input.
- PDF attachments can be rendered into page images through `pdf-to-img` and sent to vision-capable models.
- PDF rendering is bounded by file size, page count, scale, timeout, and temp-folder cleanup.

### Telemetry

- Redacted telemetry export exists.
- Prompts and assistant text are not retained raw.
- Command output is summarized and redacted.
- Tool status, error code, duration, command class, review stats, hashes, provider facts, and workflow facts are preserved.

### Veil

- Veil rejects generic system/model override fields.
- Veil validates message count and message size.
- Veil hides model inventory from health responses.
- Veil forwards tools to vLLM.
- Veil forwards tools to Ollama while omitting unsupported `tool_choice`.
- Ollama streams are converted to OpenAI-style SSE for the runner.

## Biggest Gaps

### 1. Runtime Probes

The README says Umbratic should probe dependencies, but the code mostly reports static diagnostics.

Add real probes for:

- workspace helpers like `rg`, `fd`, `git`, `jq`, `yq`, `tree-sitter`, and `bat`
- engineering runtimes like `uv`, Python, CMake, Ninja, and compilers
- artifact runtimes like `pdf-to-img`, Poppler, LibreOffice/soffice, required Python packages, and required Node packages

Probe results should affect prompt planning, skill selection, UI diagnostics, and telemetry.

Do not package or install these tools yet. For now, Umbratic should detect what exists, explain what is missing, and suggest the user install missing optional tools when that would improve the task.

### 2. Artifact Runtime

The current code has PDF attachment rendering, but not a full reference implementation-style artifact runtime.

Use the reference implementation pattern for this:

- Use a known local runtime instead of random global dependencies.
- Use PDF tooling like `reportlab`, `pdfplumber`, `pypdf`, and Poppler.
- Use a JS artifact runtime like reference implementation does for PPTX and XLSX work.
- Avoid ad hoc `python-pptx`, `openpyxl`, or `xlsxwriter` as the default authoring path unless the user explicitly asks.
- Render or export artifacts and inspect the output before claiming visual QA.

Still needed:

- PDF extraction with `pdfplumber` or `pypdf`.
- PDF generation with `reportlab`.
- PDF render/inspect with Poppler.
- DOCX creation/edit/render verification.
- PPTX creation/edit/render verification.
- XLSX creation/edit/recalculation/chart verification.
- Generated artifact output folders, previews, and open/review flow.
- Tests and telemetry for missing artifact dependencies.

Current status: PDF attachment vision input is partial; PDF/DOCX/PPTX/XLSX generation is still mostly skill guidance.

Artifact generation should happen locally for now. Templates can still live on the company server.

Template flow:

- Veil reads a server-managed template registry or template storage.
- Template entries include kind, id, version, server key/path, tags, description, availability, and checksum.
- Veil checks whether relevant templates exist for the route, mode, org, and request.
- Veil injects only matching template metadata into protected context.
- When a template is selected, the desktop/runner/artifact runtime pulls it and caches it locally.
- Suggested local cache folders:
  - `.umbratic/templates/powerpoint/`
  - `.umbratic/templates/word/`
  - `.umbratic/templates/spreadsheets/`
  - `.umbratic/templates/pdf/`
- Prompt planning can insert only matching template metadata, a short template summary, or a selected local cache path into context.
- The model should use the selected template as the visual/source contract when the user asks for a templated artifact.
- Final artifact creation and render/export verification still happen locally.

### 3. Structured Tool History

The runner currently feeds tool results back as a user message called `Workspace tool results`.

That is simple, but weaker for local model tool reliability.

Better next step:

- Preserve assistant `tool_calls`.
- Return tool results as `tool` role messages when the provider supports it.
- Keep prose fallback only for providers that need it.
- Avoid making the model infer tool history from plain text.

This is one of the biggest Osaurus-style improvements left.

### 4. Local Model Tool Calling

Already done:

- Small schemas.
- Stable schema order.
- Partial argument streaming.
- Typed tool failures.

Still needed:

- Normalize schemas before forwarding to Ollama/vLLM.
- Avoid schema shapes local model adapters handle poorly, such as array-valued `type`, boolean `additionalProperties`, or missing `type`.
- Add named/required tool filtering.
- Fail closed when a required tool call is missing.
- Add provider/model-family compatibility tests.
- Compact old completed tool history before later required calls.

### 5. Required Tool Contracts

The prompt says the model must call a file-changing tool before claiming a file was created or edited.

That should become a hard contract:

- Detect create/edit/write requests.
- Require a file-changing tool call.
- Fail closed or ask a follow-up when the model answers without the required tool.
- Record required-tool failures in telemetry.

### 6. Patch Editing

The current `edit` tool is exact single replacement.

Still needed:

- Make `edit` patch-like instead of adding another model-visible tool, unless the combined schema becomes unreliable.
- Prefer patch/edit for existing files.
- Keep `write` mainly for new files and generated artifacts.

Use a hybrid of reference implementation and Hermes:

- reference implementation pattern: strict patch grammar with `*** Begin Patch`, `*** Update File`, `*** Add File`, `*** Delete File`, and `*** End Patch`.
- Hermes pattern: one file-editing tool can support both exact replacement and multi-file patch mode.
- Umbratic should keep one model-visible `edit` tool with two modes:
  - `replace`: current exact `oldText`/`newText` behavior.
  - `patch`: strict multi-hunk patch content.
- The runner should validate patch grammar, workspace boundaries, blocked paths, and changed-file summaries before applying.
- The UI should show patch summaries in Review the same way it shows edits.

### 7. Skills

The current skill system is a good start, but it still needs:

- Offline skill import from folder or zip.
- Skill selection telemetry with skill IDs and selection reasons.
- Referenced-file/resource loading for skills.
- A `skill_read`-style path if the model needs to load full skill content after the first turn.
- Dependency gates that can hide or downgrade artifact skills when runtimes are missing.

### 8. Managed Telemetry

Telemetry export exists, but managed sync does not.

Still needed:

- Settings should show the telemetry destination/policy even before upload exists.
- If company-managed telemetry is enforced, that destination can be read-only.
- If local/export-only mode is active, settings can show where exports/spools will be written.
- Private telemetry ingestion endpoint.
- Upload auth model.
- Local spool/retry queue.
- Schema validation.
- Retention policy.
- Admin controls for upload/sync.

### 9. API Layer

The current product is desktop + local runner + Veil. That is fine for now.

If an API layer is added later, it should own:

- turn capability planning
- registry metadata
- dependency gate evaluation
- hosted/private artifact routing
- org policy
- telemetry ingestion
- evals and rollout controls

The laptop harness should stay small: snapshot local context, probe local capability, run local tools, read local skills, and return normalized results.

### 10. Evals

Add evals for:

- valid tool-call rate
- wrong-tool rate
- malformed-argument rate
- repeated read/search rate
- required-tool failure rate
- policy block rate
- runtime dependency failure rate
- artifact render/export success rate
- time to review-ready
- Ollama vs vLLM tool-call behavior

## Implementation Plan

### Phase 1: Capability Probes

Add a desktop-side probe service that answers, "what can this machine do right now?"

Probe groups:

- Required harness basics:
  - Node/runtime used by Umbratic
  - runner binary
  - Git when the workspace is a Git repo
  - read/search/edit/write/command availability
- Strongly recommended workspace helpers:
  - `rg`
  - `fd` or `fdfind`
  - `git`
- Strongly recommended Python helper:
  - `uv`
- Optional engineering helpers:
  - Python
  - CMake
  - Ninja
  - compiler toolchain
  - `tree-sitter`
  - `bat` or `batcat`
  - `jq`
  - `yq`
- Optional artifact helpers:
  - `pdf-to-img`
  - Poppler `pdftoppm`
  - Poppler `pdfinfo`
  - LibreOffice or `soffice`
  - `reportlab`
  - `pdfplumber`
  - `pypdf`
  - Node artifact packages for DOCX/PPTX/XLSX

Each probe should return:

- id
- label
- category
- required/recommended/optional
- status: `available`, `missing`, `error`, or `unknown`
- version when available
- executable path when safe to show
- short purpose
- install hint without hardcoded links
- last checked time

Missing optional tools should not block the harness. Missing required basics should show as setup problems.

### Phase 2: Settings And Diagnostics

Add a settings view for local capability status.

Settings should group probes by:

- Required
- Recommended
- Optional engineering
- Optional artifacts

Each row should show:

- available/missing state
- detected version
- why Umbratic uses it
- which workflows it affects
- a simple install suggestion
- a refresh action

The install suggestion should be plain guidance, not an installer. Examples: "Install ripgrep with your system package manager" or "Install uv from the uv installer." Do not add hardcoded links.

### Phase 3: Use Probe Results In Planning

Use probe results before prompts and runner config are built.

Rules:

- Keep `read`, `search`, `write`, `edit`, and `command` visible if the core runner can support them.
- If `rg` is missing, tell the model search still works but may be slower or fallback-based.
- If `fd` is missing, tell the model path discovery may use fallback search.
- Python tasks should almost always use `uv`.
- If `uv` is missing, do not present Python verification as the normal ready path; suggest installing `uv` when Python work needs dependencies or repeatable execution.
- Only use a non-`uv` Python fallback for simple inspection or when the user explicitly asks for it.
- If CMake, Ninja, or compilers are missing, allow code inspection but mark build verification unavailable.
- If Poppler or LibreOffice is missing, do not claim visual QA for generated artifacts.
- If PDF extraction packages are missing, prefer rendered-image inspection or state that text extraction is unavailable.

Prompt guidance should be factual and short. Do not include long install docs or external links.

### Phase 4: Skill And Runtime Gating

Use probes to choose which skills and runtime guidance are active.

Rules:

- Markdown remains available across all modes.
- Engineering workspace skill remains available in engineering mode.
- Python guidance should default to `uv` for environment setup, dependencies, and verification.
- If `uv` is missing, Python guidance should clearly say Python execution is degraded and recommend installing `uv` before dependency-heavy work.
- CMake guidance only becomes build guidance when the needed build tools exist.
- PDF/DOCX/PPTX/XLSX skills remain toggleable in settings, but their injected instructions should say whether generation/rendering is available or missing.
- Marketing and sales should see artifact skills when relevant, but the skill should be honest about unavailable artifact tooling.

This keeps the model from making false claims while still letting it produce source content, outlines, tables, and drafts when full artifact generation is unavailable.

### Phase 5: Probe Telemetry

Add redacted telemetry for capability state.

Record:

- probe id
- status
- version family when useful
- category
- workflow affected
- task id when a missing dependency affected a run

Do not record full local paths unless hashed. Do not record env vars or command output.

### Phase 6: Harden Tool Calling

- Preserve structured tool history.
- Normalize schemas for Ollama/vLLM.
- Add required tool contracts for file-changing tasks.
- Add fail-closed required-tool behavior.
- Add local model tool-call evals.

### Phase 7: Build The Artifact Runtime

- Validate the artifact runtime from probes.
- Follow the reference implementation runtime shape:
  - PDF uses Python packages plus Poppler render/inspect.
  - PPTX and XLSX use a JS artifact runtime.
  - DOCX uses deterministic document generation/editing plus render verification.
- Implement PDF extraction/generation/render verification.
- Implement DOCX/PPTX/XLSX creation and render/export verification.
- Add Veil support for a server-side template registry.
- Add template existence/availability checks in Veil.
- Let Veil include only selected template availability/metadata in protected context.
- Add local cache paths under `.umbratic/templates/` for pulled templates.
- Let the planner select only the relevant template summary or local cache path for the current task.
- Add artifact output tracking and previews.
- Add artifact dependency tests.

Do not package app-managed installers in this phase. Build the runtime usage paths so they work when dependencies already exist.

### Phase 8: Improve Editing And Skills

- Expand `edit` into a unified replace/patch tool.
- Keep `write` for new files and full generated artifacts.
- Add offline skill import.
- Add skill selection telemetry.
- Add referenced skill resource loading.

### Phase 9: Add Managed Telemetry

- Add a read-only or managed settings row for telemetry destination/policy.
- Add private telemetry ingestion.
- Add local spool/retry.
- Define retention and admin policy.
- Only then consider a larger private API planner/router.

### Future: Installer And Package Manager

Do this later, not now.

Future installer flow:

- Show required, recommended, and optional helper tools.
- Let the user choose which optional groups to install.
- Offer engineering helpers separately from artifact helpers.
- Keep marketing/sales installs focused on document and artifact support.
- Record what was installed so probes and settings match reality.

## Keep Out Of Scope For Now

- Public web search.
- Browser automation.
- Public MCP/plugin marketplace.
- Google Drive or other third-party connectors.
- Public skill downloads.
- Background automations.
- Durable memory.
- Public provider marketplace.
- Direct public model passthrough.

These can be revisited later if Umbratic becomes a private API-layer platform. They should not distract from making the local/private harness reliable first.

## Design Rules

- Keep the model-visible tool list small.
- Keep schemas stable.
- Gate tools and skills by actual availability.
- Prefer structured tool history over prose tool summaries.
- Fail closed when a required tool call is missing.
- Use skills for workflow knowledge, not giant default prompts.
- Keep Markdown available across modes.
- Keep Python, CMake, Git, and worktree guidance engineering-focused.
- Do not claim visual QA without render/export evidence.
- Do not store raw sensitive data in telemetry.
- Add evals before broad new tool families.

## Open Decisions

Resolved for now:

- Artifact runtime should follow reference implementation's pattern.
- Artifact generation should happen locally.
- Templates can live on the company server.
- Veil should know when matching server templates exist and inject/pull them when relevant.
- Local `.umbratic/templates/` is a cache/work area, not the source of truth.
- Worktrees should not become the default for every Git repo edit.
- Patch behavior should live inside the existing `edit` surface if the schema stays reliable.
- Model-family-native tool formats can wait; OpenAI-compatible tool contracts are fine for now.

Still open:

- What exact local JS/Python artifact runtime paths should Umbratic use in development before app packaging exists?
- What exact telemetry destination, auth model, retention policy, and read-only settings behavior should managed deployments use?
- What exact server template registry shape/path should Veil use?
