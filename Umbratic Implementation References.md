---
title: Umbratic Implementation References
tags:
  - umbratic
  - harness
  - implementation-references
status: draft
aliases:
  - Umbratic Code References
---

# Umbratic Implementation References

This file keeps concrete source examples behind [[Umbratic Unified Harness Blueprint]] without making the blueprint long.

## Patch And Edit

### reference implementation `apply_patch`

reference implementation exposes file patching as a grammar-backed freeform tool.

Source examples:

- `reference-agent/reference-agent-rs/core/src/tools/handlers/apply_patch_spec.rs`
- `reference-agent/reference-agent-rs/core/src/tools/handlers/apply_patch.lark`

Key shape:

```rust
const APPLY_PATCH_LARK_GRAMMAR: &str = include_str!("apply_patch.lark");

ToolSpec::Freeform(FreeformTool {
    name: "apply_patch".to_string(),
    description: "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.".to_string(),
    format: FreeformToolFormat {
        r#type: "grammar".to_string(),
        syntax: "lark".to_string(),
        definition,
    },
})
```

Grammar shape:

```lark
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
```

Umbratic takeaway:

- Keep one `edit` surface if possible.
- Add `mode: "patch"` with strict patch grammar validation.
- If a provider supports grammar/freeform tools later, expose patch mode that way.
- Until then, carry patch text in a JSON field and validate before applying.

### Hermes `patch`

Hermes keeps one patch tool with two modes.

Source example:

- `hermes-agent/tools/file_tools.py`

Key shape:

```python
def patch_tool(mode: str = "replace", path: str = None, old_string: str = None,
               new_string: str = None, replace_all: bool = False, patch: str = None,
               task_id: str = "default", cross_profile: bool = False,
               session_id: str | None = None) -> str:
```

Mode behavior:

```python
if mode == "replace":
    if not path:
        return tool_error("path required")
    if old_string is None or new_string is None:
        return tool_error("old_string and new_string required")
    result = file_ops.patch_replace(_replace_target, old_string, new_string, replace_all)
elif mode == "patch":
    if not patch:
        return tool_error("patch content required")
    result = file_ops.patch_v4a(patch)
else:
    return tool_error(f"Unknown mode: {mode}")
```

Schema shape:

```json
{
  "name": "patch",
  "parameters": {
    "type": "object",
    "properties": {
      "mode": {
        "type": "string",
        "enum": ["replace", "patch"],
        "default": "replace"
      },
      "path": { "type": "string" },
      "old_string": { "type": "string" },
      "new_string": { "type": "string" },
      "replace_all": { "type": "boolean", "default": false },
      "patch": { "type": "string" }
    },
    "required": ["mode"]
  }
}
```

Umbratic takeaway:

- `edit` can stay one model-visible tool.
- `replace` mode keeps the current exact replacement behavior.
- `patch` mode handles multi-file or multi-hunk edits.
- The runner should validate paths, blocked files, patch shape, and changed-file summaries before applying.

## Artifact Runtime

### PDF

reference implementation PDF skill source:

- `/Users/carminep/.reference-agent/plugins/cache/openai-primary-runtime/pdf/26.623.12021/skills/pdf/SKILL.md`

Core rules:

- Use Poppler rendering for visual inspection.
- Use `reportlab` for PDF generation.
- Use `pdfplumber` or `pypdf` for extraction and quick checks.
- Do not rely on text extraction for layout fidelity.
- Re-render pages after meaningful updates.

Example dependency shape:

```bash
uv pip install reportlab pdfplumber pypdf
pdftoppm -png "$INPUT_PDF" "$OUTPUT_PREFIX"
```

Umbratic takeaway:

- Prefer `uv` for Python package setup.
- Treat Poppler as the PDF visual QA gate.
- If Poppler is missing, do not claim PDF visual QA passed.

### DOCX

reference implementation document skill source:

- `/Users/carminep/.reference-agent/plugins/cache/openai-primary-runtime/documents/26.623.12021/skills/documents/SKILL.md`

Core rules:

- Use workspace/runtime dependencies, not random global packages.
- Render DOCX pages to PNGs with a renderer such as `render_docx.py`.
- Inspect rendered pages before delivery.
- If LibreOffice or `soffice` is missing, disclose that visual QA could not be completed.

Umbratic takeaway:

- DOCX generation can be local.
- Visual verification needs LibreOffice or another reliable render path.
- Artifact skills must downgrade honestly when render dependencies are missing.

### PPTX

reference implementation presentation skill source:

- `/Users/carminep/.reference-agent/plugins/cache/openai-primary-runtime/presentations/26.623.12021/skills/presentations/SKILL.md`

Core rules:

- Use a managed JS artifact runtime for presentation authoring.
- Use template/reference decks when supplied.
- Use a layout library when no stronger template or brand system exists.
- Avoid defaulting to ad hoc `python-pptx` for net-new decks.
- Check for overlap, wrapping, and visual quality before delivery.

Umbratic takeaway:

- PPTX should use a known local JS artifact runtime once probes confirm it exists.
- Server-managed templates can provide deck style contracts.
- Local generation and render/export verification still happen on the machine.

### XLSX

reference implementation spreadsheet skill source:

- `/Users/carminep/.reference-agent/plugins/cache/openai-primary-runtime/spreadsheets/26.623.12021/skills/spreadsheets/SKILL.md`

Core rules:

- Use a managed JS artifact runtime for workbook authoring.
- Avoid defaulting to `openpyxl`, `xlsxwriter`, or `pandas.ExcelWriter`.
- Preserve formulas, formatting, ranges, charts, and number/date types.
- Inspect values, formulas, and rendered output before delivery.

Umbratic takeaway:

- XLSX should use a known local JS artifact runtime once probes confirm it exists.
- Python can support analysis, but workbook creation should stay auditable and formula-driven.

## Server Template Flow

Templates can live on the company server. The model should not browse the whole template catalog.

Suggested Veil-facing template metadata:

```json
{
  "id": "sales-quarterly-review",
  "kind": "powerpoint",
  "displayName": "Sales Quarterly Review",
  "serverKey": "templates/powerpoint/sales-quarterly-review",
  "version": "2026-06",
  "tags": ["sales", "qbr", "executive"],
  "description": "Quarterly sales review deck with executive summary, pipeline, forecast, and next steps.",
  "available": true,
  "checksum": "sha256:..."
}
```

Recommended flow:

1. Veil reads a server-managed template registry or template storage.
2. Veil checks whether relevant templates exist for the route, mode, org, and request.
3. Veil injects only selected template metadata into protected context.
4. The desktop, runner, or artifact runtime pulls the selected template when needed.
5. Pulled templates are cached locally under `.umbratic/templates/<kind>/<id>/`.
6. The model sees the selected local cache path and a short template summary, not the whole server catalog.

Umbratic takeaway:

- Server templates remain server-owned.
- Local `.umbratic/templates/` is a cache/work area, not the source of truth.
- Veil should know availability and inject only the relevant template contract.

## Python Runtime

Umbratic decision:

- Python tasks should almost always use `uv`.
- If `uv` is missing, dependency-heavy Python verification should be marked degraded.
- Non-`uv` Python fallback is acceptable for simple inspection or when the user explicitly asks.

Probe implication:

- `uv` should be strongly recommended in Settings.
- Missing `uv` should produce an install suggestion without hardcoded links.

## Carry Into Umbratic Code

- Keep model-visible schemas small.
- Keep one `edit` tool unless reliability proves the combined schema is too hard for local models.
- Probe local dependencies before selecting skills or runtime guidance.
- Let Veil inject server template availability and selected template metadata.
- Run artifact generation locally.
- Do not add app packaging or installer-managed dependencies yet.
