# Artifact Pipeline

How Umbratic creates, inspects, and edits PowerPoint, Word, Excel, and PDF
files. One tool, JSON in and JSON out. The model never sees XML or library
APIs. Every result is checked deterministically. No LibreOffice, no vision, no
host installs — a JS worker and a small Rust sidecar, both shipped in the app.
Identical in local mode and in server (SSH) mode.

## Quality bar

This is a document factory, not a general Office round-tripper.

| Job | Expectation |
| --- | --- |
| Create from a spec | Strong. Clean business-template files that open in Office. |
| Edit a file this tool created | Strong. Inspect ids match the create vocabulary. |
| Light edit of someone else's ordinary file | Surgical only: replace text, refresh chart/table data, add/reorder slides using *their* layouts, redline a paragraph, append rows. |
| Restyle a designed deck, rewrite PDF body text, open pivots/macros/SmartArt | Out of scope. Inspect says so; the tool refuses the op rather than dropping parts. |

Brand on a stranger's deck is `template.mode: "reuse"` (copy their masters, fill
new slides), not freeform restyle. Office → PDF is a re-typeset via shared
blocks, not a print-faithful convert. The in-app preview is the inspect
outline — slide cards, a sheet grid, page text — not PowerPoint.

Target models are local (`qwen38-27b`, `gemma4-12b`). They can close a JSON
schema with JSON-path errors in three rounds. They cannot debug DrawingML.

## Decisions at a glance

| Question | Answer |
| --- | --- |
| Model ↔ files | One tool, `artifact` — `inspect`, `create`, `edit`. |
| Where it runs | Electron main: `utilityProcess` worker (pptx, docx, pdf) + `umbratic-artifacts` sidecar (xlsx). Runner round-trips like permissions. SSH host gets nothing new. |
| Origin | Every create stamps `UmbraticArtifact=1`. Inspect reports `origin` + `editSurface` + `unsupported[]`. |
| Preview | Existing DOCX review panel, generalised. Outline is the sidecar. Copy: this is a structured preview, not the file. |
| Verification | Schema → structural → geometry → recalc. Result carries `qa[]`. |
| Size | ≈ 10–15 MB in the installer. Nothing optional, nothing downloaded. |

## Architecture

```text
Local model --artifact tool--> Runner (paths · permission · timeout)
                                  |  artifact.requested (SSE)         ^ reply (POST /artifact/{id}/reply)
                                  v                                    |
                              Electron main: ArtifactService ----------+
                                  |-- utilityProcess worker (pptx · docx · pdf)
                                  |-- umbratic-artifacts sidecar (xlsx)
                                  '-- workspace (local fs, or SSH pull/push)
```

The runner validates shape and size, confines `path`/`out`, asks write
permission on create/edit (same kind as `write`), emits `artifact.requested`,
and awaits a oneshot. The desktop stages the input, runs the engine and QA,
writes atomically, and replies. Same pattern as `permission.requested` →
`POST /permission/{id}/reply` in `packages/runner/src/server.rs`.

Why the desktop: server mode pushes a Rust binary to the remote host; there is
no Node there. The desktop already moves bytes over SSH and already owns PDF
rendering. The runner keeps policy, confinement, permission, timeouts.

`inspect` is a read. `create` / `edit` are writes. Repeat guard treats create
and edit as mutating (`packages/runner/src/repeat_guard.rs` — add `artifact`
next to `write` | `edit` | `command`).

## Inspect surface

Every inspect (and the summary on create/edit) carries:

```jsonc
{
  "origin": "umbratic" | "foreign",
  "editSurface": "full" | "surgical" | "inspect-only",
  "unsupported": [ { "kind": "pivot", "where": "Sheet3" } ]
}
```

Stamp on create: OOXML `docProps/custom.xml` property `UmbraticArtifact` =
`1`; PDF Info `/UmbraticArtifact (1)`. Presence ⇒ `origin: "umbratic"`.

`editSurface`:

- `inspect-only` — encrypted, legacy `.ppt`/`.doc`/`.xls`, or the file cannot
  be opened. Edit returns `ok: false` with those kinds. Do not save a
  half-parsed package.
- `surgical` — foreign file that opened cleanly, or an Umbratic file that
  still contains an unsupported feature. Allowed ops are the surgical set
  below. An op that would touch an unsupported feature is refused; untouched
  zip parts stay byte-identical.
- `full` — Umbratic origin and `unsupported` is empty. Whole op set.

Closed `unsupported.kind` list:

| Format | Kinds |
| --- | --- |
| pptx | `smart-art`, `ole`, `animation`, `embedded-media`, `encrypted`, `legacy-ppt` |
| docx | `content-control`, `vml-drawing`, `mail-merge`, `macro`, `encrypted`, `legacy-doc` |
| xlsx | `vba`, `pivot`, `power-query`, `external-link`, `slicer`, `encrypted`, `legacy-xls` |
| pdf | `encrypted`, `scanned`, `xfa` |

A scanned PDF is still readable (native inspector + OCR digest). Its edit
surface is surgical: page ops only.

## Engines

| Format | Create | Inspect | Edit | Where |
| --- | --- | --- | --- | --- |
| PPTX | `pptxgenjs` 4.0.1, fixed layouts, corruption validator | JSZip + xmldom: theme, layouts, shapes `{id, name, kind, text, bbox}`, notes, tables, chart data | OOXML ops; template reuse writes into a copy of the source deck | JS worker |
| DOCX | `docx` 9.7.1, 5 presets | xmldom: blocks `b12`, style, text, tables, comments, tracked changes | OOXML ops: run-merge, redline, comments, placeholders | JS worker |
| PDF | `pdfmake` 0.3.11, bundled Roboto | `packages/pdf` for text; `pdfjs-dist` for pages, forms, metadata | `@cantoo/pdf-lib` 2.8.3: page ops, forms, metadata. No body-text rewrite | JS worker |
| XLSX | `rust_xlsxwriter` 0.98 | `calamine` 0.36 + umya | `umya-spreadsheet` 3.0.1 (keeps charts/CF/DV) + `formualizer` 0.8 recalc | Rust sidecar |

JS: `pptxgenjs`, `docx`, `@xmldom/xmldom` 0.9.12, `jszip` 3.10.1, `pdfmake`,
`@cantoo/pdf-lib`; already present `pdfjs-dist`, `@napi-rs/canvas`. MIT/Apache,
exact pins, no install scripts. One override: `image-size` → 2.x under
pptxgenjs (DoS in 1.x). Fonts: Carlito, Caladea, Liberation (OFL, ~2 MB) for
measurement — metric-compatible with Calibri/Cambria/Arial, same trick Claude's
skill documents.

Not used: `exceljs`, SheetJS `xlsx`, `hyperformula`, `mupdf`, LibreOffice,
Typst, Poppler, Python. The model never writes `pptxgenjs` or Python; the
worker does.

DOCX and PDF share one block vocabulary. `inspect docx` → `create pdf` is a
re-typeset, not pixel-identical. Charts in DOCX/PDF are SVG; PPTX/XLSX charts
are native.

## Tool contract

Catalog today has no nested-JSON field. Add `FieldKind::JsonObject { max_bytes }`
and `FieldKind::JsonArray { max_items, max_bytes }` in
`packages/runner/src/tools/catalog.rs`. Schema for those fields is
`type: object` / `type: array` with a byte cap; the worker validates the spec
against the format schema. Top-level `additionalProperties: false` stays.

```jsonc
artifact {
  action: "inspect" | "create" | "edit",          // required
  format?: "pptx" | "docx" | "xlsx" | "pdf",     // required for create; else inferred from path
  path?:  "workspace-relative input",              // inspect / edit
  out?:   "workspace-relative output",             // create / edit; default .umbratic/artifacts/<format>/<name>
  spec?:  { ... },                                 // create, JsonObject ≤ 1 MiB
  ops?:   [ ... ],                                 // edit, JsonArray ≤ 200 items, ≤ 512 KiB
  options?: { tracked: true, author: "Umbratic" }
}
```

Action matrix (enforced in `tools/artifact.rs`, described in the tool text):
inspect requires `path`; create requires `format` + `spec`; edit requires
`path` + `ops`. `out` defaults. Nothing is written on `ok: false`.

```jsonc
{ "ok": true, "path": ".umbratic/artifacts/pptx/q3-review.pptx", "bytes": 184322,
  "origin": "umbratic", "editSurface": "full", "unsupported": [],
  "summary": "9 slides · 0 errors, 2 warnings",
  "qa": [ { "severity": "error", "where": "slide 4 · Content 2", "kind": "text-overflow",
            "message": "6 bullets need 118% of the box", "fix": "shorten or split" } ],
  "outline": { ... } }   // inspect always; create/edit omit outline (stay under the 16 KiB shown cap)

{ "ok": false, "errors": [ { "path": "slides[3].bullets", "message": "7 items; max 6 — split the slide" } ] }
{ "ok": false, "errors": [ { "path": "ops[0]", "message": "editSurface is inspect-only (encrypted)" } ] }
```

Limits: input ≤ 64 MiB inflated, timeout 120 s default / 600 s max, result ≤
16 KiB shown (rest via `retrieve_context`), QA truncated to the 25 most severe
with counts. Gate: `Gate::Service("artifact")`. Advertise from the desktop
whenever the worker binary exists — including SSH tasks; unlike
`workspace_graph` this service lives on the desktop, not the remote host.
`path` / `out` use the same confinement as `read` / `write`. Create/edit ask
permission kind `write`.

`.umbratic` is currently a generated-path *name*, so
`.umbratic/artifacts/…` is invisible to `ls`/`find`/`search`. Change
`is_generated_runtime_path` in `packages/runner/src/policy.rs`: drop
`.umbratic` from the directory-name list; keep the prefixes
`.umbratic/runtime/`, `build/`, `tmp/`, `index/`. Add tests that artifacts
are listed and runtime stays hidden.

Add `"artifact"` to `RUNNER_TOOL_NAMES` in `config.rs`.

## Specs

Enums, no coordinates, no colours or point sizes (`theme` / `preset` / `role`
decide). Hard limits with JSON-path errors. Inline markup: `**bold**`,
`*italic*`, `` `code` ``. One JSON Schema per format lives in
`apps/desktop/src/main/artifacts/schemas/` and is rendered to
`references/spec.md` at build time (`scripts/generate-skill-references.ts`).

### PPTX

```jsonc
{ "format": "pptx", "version": 1,
  "theme": { "preset": "clean-light | clean-dark | warm", "accent": "#2F6FD0" },
  "template": { "path": "decks/brand.pptx", "mode": "reuse | style", "keepSlides": [1, "last"] },
  "slides": [
    { "layout": "title", "title": "…", "subtitle": "…", "notes": "…" },
    { "layout": "section", "title": "…" },
    { "layout": "bullets", "title": "…", "bullets": ["…", { "text": "…", "level": 1 }] },
    { "layout": "two-column", "title": "…", "left": { "bullets": [] }, "right": { "image": "assets/x.png" } },
    { "layout": "image", "title": "…", "image": "assets/x.png", "caption": "…" },
    { "layout": "chart", "title": "…", "chart": { "type": "bar | column | line | pie | scatter",
                                "categories": [], "series": [{ "name": "…", "values": [] }] } },
    { "layout": "table", "title": "…", "columns": [], "rows": [[]] },
    { "layout": "kpis", "title": "…", "items": [{ "label": "ARR", "value": "$4.2M", "delta": "+12%" }] },
    { "layout": "quote", "quote": "…", "attribution": "…" },
    { "layout": "closing", "title": "…" } ] }
```

Limits: ≤ 6 bullets / slide, ≤ 90 characters on level-0, title ≤ 60, tables ≤
8×12, 2–4 KPIs, images inside the workspace. Geometry is fixed per layout, so
overlap cannot happen on create.

`template.mode: "reuse"` (default when `template.path` is set) copies the
source: theme, masters, layouts untouched; slides cleared except `keepSlides`;
each new slide instantiates a source layout (`inspect` lists them by name and
placeholder type; we map title/body/picture). The file *is* their theme.
`mode: "style"` lifts colours/fonts/background into our theme and builds with
our layouts.

Ops, addressed by slide number and shape name from inspect:

| Surface | Ops |
| --- | --- |
| surgical | `replaceText`, `setBullets`, `setNotes`, `replaceImage`, `setChartData`, `setTable`, `findReplace`, `duplicateSlide`, `moveSlide`, `deleteSlide`, `insertSlide` (source layouts only) |
| full | surgical + `insertSlide` with our generic layouts mapped onto the deck's placeholders |

`duplicateSlide` on a slide that has `smart-art` or `ole` is refused (cloning
those parts corrupts the deck). Chart data is replaced in place, not cloned
across files.

### DOCX and PDF (shared blocks)

```jsonc
{ "format": "docx" | "pdf", "version": 1,
  "preset": "standard_business_brief | compact_reference_guide | narrative_proposal | simple_word_default | form_or_questionnaire",
  "page": { "size": "Letter | A4", "orientation": "portrait" }, "meta": { "title": "…", "author": "…" },
  "header": { "text": "…" }, "footer": { "text": "…", "pageNumbers": true }, "toc": true,
  "blocks": [
    { "type": "title", "text": "…", "subtitle": "…" }, { "type": "heading", "level": 1, "text": "…" },
    { "type": "paragraph", "text": "… **bold** …" }, { "type": "bullets", "items": [] }, { "type": "numbered", "items": [] },
    { "type": "checklist", "items": [] }, { "type": "definitions", "items": [{ "term": "…", "definition": "…" }] },
    { "type": "callout", "style": "note | warning | decision | summary", "title": "…", "text": "…" },
    { "type": "table", "columns": [{ "header": "…", "width": "20%", "align": "left" }], "rows": [[]], "caption": "…" },
    { "type": "image", "path": "…", "width": "80%", "caption": "…", "alt": "…" }, { "type": "chart", "chart": {} },
    { "type": "quote", "text": "…", "attribution": "…" }, { "type": "pageBreak" },
    { "type": "signature", "fields": ["Name", "Date"] }, { "type": "formField", "label": "…", "kind": "text | checkbox | choice" } ] }
```

Presets own typography. Limits: heading 1–3, tables ≤ 10 columns, callout ≤
600 characters, one `title`.

DOCX ops (block ids from inspect). Runs are coalesced before search so find
matches what the user sees. Untouched parts stay byte-identical.

| Surface | Ops |
| --- | --- |
| surgical | `replaceText {find, replace, scope, tracked}`, `addComment`, `fillPlaceholders`, `setMetadata`, `insertAfter` / `deleteBlock` on inspect ids |
| full | surgical + `replaceBlock`, `setHeading`, `acceptAllChanges` / `rejectAllChanges` |

`tracked: true` writes `w:ins`/`w:del` with author and date. Comments write
the four comments parts plus rels. Accept/reject only when asked to finalise.

PDF ops (always surgical — there is no `full` body rewrite): `merge`, `split`,
`extractPages`, `deletePages`, `reorder`, `rotate`, `insertBlank`, `watermark`,
`stamp`, `fillForm`, `flatten`, `setMetadata`. To change body copy, rebuild
from source with `create`.

### XLSX

```jsonc
{ "format": "xlsx", "version": 1,
  "sheets": [ { "name": "Assumptions",
    "columns": [{ "header": "Item", "width": 28 }, { "header": "Value", "width": 14, "format": "0.0%" }],
    "rows": [ ["Growth", { "v": 0.05, "role": "input" }], ["Churn", { "f": "=1-B2", "role": "calc" }], ["Start", { "d": "2026-01-31" }] ],
    "table": { "name": "tblAssumptions", "style": "medium2" }, "freeze": "A2", "namedRanges": { "growth": "B2" },
    "validation": [{ "range": "B2:B10", "type": "decimal", "min": 0, "max": 1 }],
    "conditional": [{ "range": "C2:C50", "rule": "cellIs", "operator": "lessThan", "value": 0, "style": "bad" }],
    "charts": [{ "type": "line", "title": "…", "categories": "Data!A2:A13", "series": [{ "name": "Rev", "values": "Data!B2:B13" }], "anchor": "E2" }] } ] }
```

Cells: number · string · boolean · `{f}` formula · `{d}` ISO date · `{v,
format, role}`. `role` (input / calc / output / total / header) maps to the
finance colour convention.

Create-time formula allowlist (schema-enforced; anything else is
`ok: false` at `rows[i].f`). This is the set we golden-test, not the full
formualizer catalogue:

`SUM SUMIF SUMIFS COUNT COUNTA COUNTIF COUNTIFS AVERAGE AVERAGEIF AVERAGEIFS
MIN MAX ABS ROUND ROUNDUP ROUNDDOWN IF IFERROR IFNA AND OR NOT INDEX MATCH
VLOOKUP HLOOKUP XLOOKUP TEXT LEFT RIGHT MID LEN TRIM CONCAT CONCATENATE
TODAY DATE YEAR MONTH DAY EOMONTH N PMT FV PV RATE`

New formulas on edit must be on that list. Formulas already in a foreign
file are left alone.

Recalc: formualizer runs after every create/edit. `#REF!` `#DIV/0!` `#NAME?`
`#VALUE!` `#N/A` → QA error. A function it cannot evaluate → QA *warning*,
and the cell's existing cached value is kept. Never write a guessed number
over Excel's cache. Unknown names and circular refs are errors.

Ops:

| Surface | Ops |
| --- | --- |
| surgical | `setCells`, `appendRows`, `insertRows` / `insertColumns` (refs shift), `deleteRows` / `deleteColumns`, `findReplace`, `addSheet`, `renameSheet`, `setFormat`, `setFreeze` |
| full | surgical + `setValidation`, `setConditional`, `addChart`, `setNamedRange`, `deleteSheet` |

`inspect` per sheet: dimensions, header, first 20 rows, sampled formula map,
names, tables, charts, validation, freeze, merged/hidden flags.

## Verification

Pure functions `(file) → qa[]`. No renderer, no external process, no image.

1. **Schema** — JSON Schema, JSON-path errors. Nothing is built if this fails.
2. **Structural** — zip/XML well-formed; relationship targets exist; content
   types cover every part; re-inspect counts match the spec; pptxgenjs
   corruption rules (empty shape without `txBody`, 8-digit hex colour, stacked
   chart `outEnd`, combo chart missing `catAxes`).
3. **Geometry** — `measureText` with bundled fonts, wrapped at box width.
   Error above 100 % of box height, warning above 90 %; sibling overlap;
   off-slide; image aspect distortion; docs: column narrower than its longest
   word, heading then page-break, empty section, TOC with no headings;
   charts: series/category mismatch, more than 12 pie slices.
4. **Recalc** — as above. Create/edit formula count and sheet dimensions must
   match the spec.

Loop: fix every *error*, judge *warnings*, rebuild; at most three rounds; the
spec or ops must change between rounds (repeat guard). On fixed layouts the
recurring error is text overflow — shorten or split.

## Skills

Replace Presentations / Documents / Spreadsheets / PDF bodies. Each `SKILL.md`
≤ 6 KB, plus generated `references/spec.md` and `references/ops.md`.
Frontmatter names file types and verbs; that is the routing signal. Remove the
orphaned `umbratic-ocr` directory (OCR stays a section of the PDF skill). Drop
the `node-*`, `py-*`, Poppler, and LibreOffice probes from `capabilities.ts`.
One fact line when an artifact skill is enabled: `Artifact builder: pptx, docx,
xlsx, pdf`. Not gated on the user prompt.

Shared flow:

1. Named or attached file → `inspect` first. Plan from `outline`,
   `editSurface`, and `unsupported`. Never guess ids.
2. `inspect-only` → say why, stop. Offer `create` (optionally
   `template.reuse`) rather than ops.
3. `surgical` on a foreign file → only surgical ops. Do not restyle. For a
   brand deck the user wants copied, `create` with `template.mode: "reuse"`.
4. Two lines of plan: audience, purpose, outline. Ask once only if a
   decision-critical fact is missing; otherwise state assumptions in the file.
5. Emit spec or ops. Ground numbers in supplied material; write
   `[proof needed: …]` instead of inventing. Never paste library APIs.
6. `create` / `edit` under `.umbratic/artifacts/<format>/` unless the user
   gave a path.
7. `ok: false` → fix `errors[].path`. `ok: true` → fix every QA error, at
   most three rounds.
8. Deliver: path, origin/editSurface, rounds, remaining warnings, assumptions.
   Never paste the spec.

Per format: one message per slide, detail in notes; `tracked: true` only when
the user says redline; XLSX inputs/calcs/outputs separated, every derived
value a formula; PDF edits are page-level; reading/OCR unchanged.

## Implementation

Ship PPTX end-to-end before opening the next format. Each phase is mergeable.

### 0 — Contract (runner, no engines yet)

- `FieldKind::JsonObject` / `JsonArray` in `catalog.rs`.
- Tool `artifact`, `Gate::Service("artifact")`, action matrix in
  `tools/artifact.rs`.
- `POST /artifact/{id}/reply` next to the permission route.
- `services.artifact` in session config; desktop sets it when the worker
  exists (local and SSH).
- Policy: artifacts visible, runtime/build/tmp/index still hidden.
- Repeat guard: mutating `artifact` calls.
- Veil golden: add the new tool to
  `apps/desktop/tests/fixtures/tool-contract.golden.json`
  (`UPDATE_FIXTURES=1`). Unknown nested spec fields must survive — that is
  the wire-compat rule.
- Headless runner tests: tool absent unless the service is declared.

### 1 — PPTX worker

`apps/desktop/src/main/artifacts/worker/` forked like
`pdfRendererWorker.js` in `workspaceSnapshot.ts`, with
`--permission --allow-fs-read=… --allow-fs-write=… --allow-addons`. No
sockets. Layouts, template reuse, inspect, surgical+full ops, origin stamp,
unsupported detection, QA. Golden create → inspect. Foreign-file fixtures
(a simple deck and one with SmartArt) prove surgical vs inspect-only.

### 2 — Desktop service + preview + packaging for PPTX

`ArtifactService` job queue, local/SSH transport (pull ≤ 64 MiB, stage +
`mv`, checksum), event wiring in `runnerEventAdapter.ts`. Preview: generalise
`shared/documentReview.ts` → `artifactReview.ts`; path rule is “any file this
tool wrote” (`.umbratic/artifacts/{pptx,docx,xlsx,pdf}/`), not a
`.review.json` sidecar — the outline from the last inspect/create is enough.
UI copy: structured preview, not a renderer. Stage fonts. Pins +
`supply-chain:check`.

### 3 — DOCX, then 4 — XLSX sidecar, then 5 — PDF

Same shape. Sidecar: `packages/artifacts/`, workspace member, stdin/stdout
JSON, packaged like `packages/pdf` (`prepare-package.ts`,
`verify-package.ts`, `electron-builder.yml`, root `Cargo.toml`).
`apps/desktop/AGENTS.md` currently names four packaged binaries; this adds
`umbratic-artifacts`.

### 6 — Skills

Rewrite the four skill bodies; installer copies whole skill folders including
`references/`.

Worker never opens a socket. Node 24 API surface (Electron 43).

## Tests

- **Golden create → inspect** per layout, block type, sheet feature.
- **Edit ops:** fixture → op → inspect equals expected; zip parts the op did
  not target are byte-identical.
- **Foreign files:** at least one ordinary file per format (surgical succeeds)
  and one with an unsupported feature (op that would touch it is refused;
  inspect-only for encrypted).
- **Origin stamp** survives a round-trip open in our inspect.
- **QA detectors:** one fixture per rule, including each pptxgenjs corruption
  case.
- **XLSX:** allowlist rejection; `#DIV/0!`; unevaluable function keeps the
  cached value and warns; allowlisted formulas write cached results.
- **Schemas:** valid examples pass; one invalid example per limit.
- **Runner:** happy path, timeout, permission denied, oversize spec, path
  escape, service absent; artifacts listed, `.umbratic/tmp` not.
- **Model evals (manual):** 2 prompts × shipped formats on `qwen38-27b` and
  `gemma4-12b` — file opens, zero QA errors within 3 rounds, no invented
  facts. Include one “edit this deck you just made” and one “edit this
  attached stranger deck” prompt.

## Server mode

Nothing new on the remote host. SSE to the desktop, pull input, build
locally, push to the confined path, checksum, reply. Transfer counts against
the tool timeout. Remote paths through `shellQuote`. Drop mid-job →
`ok: false`, `kind: "transport"`, nothing written. The file is briefly on the
operator laptop; it does not leave the user's machines.

## Dropped, on purpose

- **LibreOffice** — no rendered thumbnails, no second-opinion recalc, no
  faithful Office→PDF. Saves ~300 MB and the C++ surface. Do not add it later
  as an optional probe; the design does not have a hole for it.
- **Vision** — geometry QA covers overflow/overlap/off-page. Additive later
  behind the existing `vision` flag (`mmproj` locally, full checkpoint on
  vLLM) without changing this contract.
- **Model-authored library code** — the current skills tell the model to call
  `pptxgenjs` / `reportlab` when the host happens to have them. That path is
  deleted.

## Risks

- Scope: PPTX through phase 2 before DOCX.
- `pptxgenjs` is single-maintainer; the validator and fixed layouts insulate;
  the OOXML editor can take over create if needed.
- `formualizer` is young; allowlist + keep-cache-on-unknown is the mitigation.
- Untrusted zip: 64 MiB inflated cap, no external entities in xmldom.
- umya round-trip of a stranger workbook with charts is why we picked it over
  openpyxl; still golden-test a charted foreign file, because that is the
  case that usually corrupts.
