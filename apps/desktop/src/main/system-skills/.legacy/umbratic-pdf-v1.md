---
name: PDF
description: Use for local PDF reading, extraction, generation, rendering, page-aware review, and polished PDF deliverables.
---

# PDF

## When To Use

- Read, summarize, compare, or review local PDF files where page order, layout, tables, images, or visual fidelity matter.
- Create PDF reports, one-pagers, white papers, handouts, and other fixed-layout business artifacts.
- Convert structured source material into a polished PDF deliverable that can be rendered and inspected locally.

## Local Workflow

1. Treat supplied PDFs and source files as the factual source of truth. Separate extracted facts, assumptions, and generated copy.
2. Use `pdfplumber` or `pypdf` for extraction, metadata checks, page counts, outlines, and quick text verification. Do not rely on extracted text for layout fidelity.
3. Generate new PDFs with `reportlab` when PDF authoring is requested and the Python artifact runtime is available.
4. Render final PDFs with Poppler (`pdftoppm` plus `pdfinfo`) before claiming visual QA.
5. Inspect rendered page PNGs for clipping, overlap, illegible type, bad table geometry, missing images, broken glyphs, page-number issues, and awkward section breaks.

## Paths And Files

- Keep generated PDF deliverables under `.umbratic/artifacts/pdf/` unless the user requests a specific path.
- Use `.umbratic/templates/pdf/` only for user-supplied or server-selected templates; do not invent a protected template.
- Put temporary extraction, render, and QA files under a task-specific scratch directory and keep final filenames stable and descriptive.

## Quality Bar

- Maintain a polished hierarchy: deliberate margins, consistent typography, clear section rhythm, aligned tables, and readable captions.
- Tables and charts must have explicit labels, balanced spacing, and legible values. Fix cramped columns before shrinking text.
- Preserve citations and source references as human-readable text. Do not leave tool tokens, placeholders, or raw extraction artifacts in the final PDF.
- Use ASCII hyphens in generated prose unless a source document requires a specific character.

## Fallbacks

- If extraction packages are missing, use available render/page inspection paths or state the extraction gap.
- If `reportlab` is missing, provide clean structured source content and state the PDF generation gap.
- If Poppler render tools are missing or rendering fails, do not claim PDF visual QA. State exactly what was checked instead.
