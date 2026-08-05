---
name: PDF & OCR
description: Use for local PDF reading, extraction, generation, rendering, page-aware review, and OCR of images or scanned documents.
---

# PDF & OCR

## When To Use

- Read, summarize, compare, or review local PDF files where page order, layout, tables, images, or visual fidelity matter.
- Create PDF reports, one-pagers, white papers, handouts, and other fixed-layout business artifacts.
- Convert structured source material into a polished PDF deliverable that can be rendered and inspected locally.
- Extract text from screenshots, scans, photographed documents, image attachments, and scanned PDFs when embedded text is missing or unreliable.

## Local Workflow

1. Treat supplied PDFs and source files as the factual source of truth. Separate extracted facts, assumptions, and generated copy.
2. Prefer the native inspector for reading: attached PDFs arrive pre-routed (native text extract for text PDFs, page images for scans), and the `read` / `read_attachment` tools return the same native Markdown extract with page markers, classification, and page counts.
3. Fall back to `pdfplumber` or `pypdf` only when the native extract reports encoding issues, when table or layout structure must be reconstructed, or for metadata and outline inspection the native extract does not cover.
4. Generate new PDFs with `reportlab` when PDF authoring is requested and the Python artifact runtime is available.
5. Render final PDFs with Poppler (`pdftoppm` plus `pdfinfo`) before claiming visual QA.
6. Inspect rendered page PNGs for clipping, overlap, illegible type, bad table geometry, missing images, broken glyphs, page-number issues, and awkward section breaks.

## OCR Workflow

1. Prefer clean embedded PDF text when it is available and layout fidelity is not important. The native inspector flags pages without a text layer and garbled encodings; reserve OCR and vision for those pages.
2. For image or scanned-PDF text, use the local OCR artifact digest when one is provided in the prompt.
3. Treat OCR Markdown as the readable digest and OCR JSON as the auditable source for coordinates, page numbers, confidence, warnings, and timing.
4. Preserve uncertainty. Mention low-confidence lines when a value matters, and never silently drop uncertain text.
5. If warnings mention columns or table-like layouts, review the relevant page and line evidence before making strong claims.

## Paths And Files

- Keep generated PDF deliverables under `.umbratic/artifacts/pdf/` unless the user requests a specific path.
- Use `.umbratic/templates/pdf/` only for user-supplied or server-selected templates; do not invent a protected template.
- Put temporary extraction, render, and QA files under a task-specific scratch directory and keep final filenames stable and descriptive.
- Keep OCR outputs under `.umbratic/artifacts/ocr/`; use `*.ocr.json` for the structured contract and `*.ocr.md` for the digest.

## Quality Bar

- Maintain a polished hierarchy: deliberate margins, consistent typography, clear section rhythm, aligned tables, and readable captions.
- Tables and charts must have explicit labels, balanced spacing, and legible values. Fix cramped columns before shrinking text.
- Preserve citations and source references as human-readable text. Do not leave tool tokens, placeholders, or raw extraction artifacts in the final PDF.
- Use ASCII hyphens in generated prose unless a source document requires a specific character.

## Fallbacks

- If the native extract reports encoding issues or a page has no text layer, do not trust that text; use vision/OCR paths for those pages.
- If extraction packages are missing, use the native extract or available render/page inspection paths, or state the extraction gap.
- If `reportlab` is missing, provide clean structured source content and state the PDF generation gap.
- If Poppler render tools are missing or rendering fails, do not claim PDF visual QA. State exactly what was checked instead.
- If the OCR engine is missing or fails on a page, preserve the warning and do not claim that page was read.
- Do not claim table reconstruction, formula recognition, chart parsing, or document-layout analysis unless a separate verified capability was used.
