# Umbratic

Umbratic is a private AI workbench for teams running local or company-managed model infrastructure. The desktop app talks to a local runner for workspace tools, and the runner talks to Veil, the authenticated model boundary in front of an admin-configured Ollama or vLLM runtime.

Umbratic is not a public connector platform. The supported harness surface is intentionally small: local workspace tools, local skills, Veil runtime profiles, worktree review, approval flows, and redacted operational telemetry retained on company-managed servers.

## Architecture

```text
Electron desktop app
  -> local runner on 127.0.0.1
    -> Veil authenticated model boundary
      -> private Ollama or vLLM runtime
  -> local workspace files and commands
  -> local ~/.umbratic/skills
  -> optional local document artifact runtime
  -> task, review, and telemetry storage
```

## Product Boundary

In scope:

- Read, search, edit, write, and command tools inside the selected workspace.
- Veil as the only supported model endpoint path.
- Admin-configured Ollama or vLLM runtimes hidden behind Veil.
- Local skills stored under `~/.umbratic/skills`.
- Runtime profiles for workspace toolchains, Python, CMake, Markdown, Git, and worktrees.
- Local document artifact workflows for PDF, DOCX, PPTX, and XLSX when installed runtime support is available.
- Worktree-based review and approval before changes are accepted.
- Redacted telemetry with useful workflow, tool, policy, permission, review, and failure facts.

Out of scope:

- Browser automation and web extraction.
- Web search.
- MCP or third-party connectors.
- Public skill marketplaces or internet skill downloads.
- Scheduled jobs, reminders, durable memory, or background automations.
- Generic provider marketplaces or direct public model passthrough.

Telemetry should capture everything operationally useful while avoiding raw sensitive data. Prompts, assistant text, full command output, full diffs, absolute paths, and secrets are redacted or summarized before export or sync. Managed deployments should store telemetry only on company-controlled servers.

Harness modes select different local guidance. Engineering mode can add workspace, Git, worktree, Python, CMake, or Markdown runtime profiles when relevant. Marketing and sales mode avoid engineering profiles by default, but Markdown remains available across modes for Markdown-shaped requests. Those modes instead add system skills for PDFs, DOCX documents, PPTX presentations, XLSX spreadsheets, campaign content, and sales enablement. System and personal skills are visible in Skills settings, can be toggled, and can be edited; system skills are editable files under `~/.umbratic/skills/system/<id>/SKILL.md`, while personal skills remain stored under `~/.umbratic/skills`. Umbratic shows compact skill metadata by default and includes full skill instructions only when a skill is explicitly requested or strongly matched to the task.

## Install Runtime Expectations

Umbratic should install or validate a small versioned local runtime instead of depending on whatever happens to be on the user's global `PATH`.

Recommended installer bundle:

- Core: app-managed Node.js runtime, runner dependencies, Git, and a private Veil endpoint configuration.
- Engineering helpers: `rg`, `fd`, `uv`, CMake, Ninja, compiler toolchains, `jq`, `yq`, `tree-sitter`, and `bat` when engineering mode is enabled.
- PDF artifacts: Poppler commands such as `pdftoppm` and `pdfinfo`, plus Python packages `reportlab`, `pdfplumber`, and `pypdf`.
- DOCX/PPTX/XLSX artifacts: a bundled Node artifact runtime for Office files, plus LibreOffice or another local render/export path for visual QA.
- Skills: system skills for Markdown, PDF, document, presentation, spreadsheet, marketing, sales, and engineering workflows under `~/.umbratic/skills/system/<id>/SKILL.md`, plus personal skills under `~/.umbratic/skills`.

The app should probe these dependencies and expose the matching runtime profiles or artifact skills only when they can work. PDF text extraction is useful for quick checks, but final PDF, DOCX, PPTX, and XLSX work should use render/export verification before claiming visual QA.

## Project Structure

- `apps/desktop/` - Electron, Vite, React, and TypeScript desktop app.
- `packages/runner/` - local TypeScript runner with the fixed workspace tool loop.
- `infrastructure/veil/` - Go service that owns auth, protected prompts, route policy, model configuration, and runtime calls.

## Getting Started

Install dependencies:

```sh
npm install
```

Run the desktop app in development:

```sh
npm run desktop:dev
```

Build the desktop app:

```sh
npm run desktop:build
```

Run Veil locally:

```sh
npm run veil:dev
```

Run the full test suite:

```sh
npm run test:all
```
