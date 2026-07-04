---
name: OCR
description: Use for local OCR of image, screenshot, scanned PDF, and form-like attachments with coordinates and confidence.
---

# OCR

## When To Use

- Read or extract text from screenshots, scans, photographed documents, image attachments, and scanned PDFs.
- Use when a PDF has weak or empty embedded text extraction, or when page and line locations matter.
- Use for source-grounded extraction, document QA, comparisons, and form-field review where confidence and page references matter.

## Local Workflow

1. Prefer clean embedded PDF text when it is available and layout fidelity is not important.
2. For image or scanned-PDF text, use the local OCR artifact digest when one is provided in the prompt.
3. Treat OCR Markdown as the LLM-facing digest and OCR JSON as the auditable source for coordinates, page numbers, confidence, warnings, and timing.
4. Preserve uncertainty. Mention low-confidence lines when a value matters, and avoid silently dropping uncertain text.
5. Use simple reading order for normal pages. If the OCR warnings mention columns or table-like layout, review the relevant page/line evidence before making strong claims.

## Paths And Files

- Keep OCR outputs under `.umbratic/artifacts/ocr/` unless the user asks for a specific workspace path.
- Expected final OCR artifacts are `*.ocr.json` for the structured contract and `*.ocr.md` for the digest.
- Do not create hosted OCR calls, runtime model downloads, training data exports, RL loops, or automatic learning jobs.
- Keep OCR text, coordinates, image data, and detailed failures local in artifacts or existing diagnostics. Managed telemetry should contain only compact capability and run facts.

## Fallbacks

- If the OCR engine is missing, state the gap and use normal image or PDF context only when it is available.
- If OCR fails on a page, preserve the warning and avoid claiming the page was read.
- Do not claim table reconstruction, formula recognition, chart parsing, seal detection, or document-VLM layout analysis unless a separate verified capability is actually available and used.
