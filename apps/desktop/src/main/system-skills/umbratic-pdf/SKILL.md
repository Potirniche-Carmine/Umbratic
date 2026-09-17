---
name: PDF & OCR
description: Use to create, inspect, or edit PDF files — reports, one-pagers, whitepapers, proposals; and page-level work on an existing PDF such as merge, split, rotate, watermark, stamp, fill a form, or read a scan with OCR.
---

# PDF

Everything goes through the `artifact` tool. You send JSON; the engine typesets
the file or applies page operations. Never write `reportlab`, `pypdf`, or any
other library code, and never shell out to Poppler or Ghostscript.

## The one thing to understand about editing a PDF

**A PDF has no paragraphs.** It has glyphs at coordinates, with line breaks a
program you never saw decided. So there is no `replaceText` and there never will
be: rewriting a sentence would mean reflowing a page whose layout you cannot
reconstruct, and the result overlaps itself.

The ops are page-level and metadata-level: `merge`, `split`, `extractPages`,
`deletePages`, `reorder`, `rotate`, `insertBlank`, `watermark`, `stamp`,
`fillForm`, `flatten`, `setMetadata`.

**To change the words, rebuild from source with `create`.** If the user wants
the body text of a PDF changed and you do not have the source, say that plainly
and offer to rebuild it from the content you can read.

Before each create, read `references/spec.md` with `read_skill`, using this
skill's id and `resource: "references/spec.md"`. Before each edit, read
`references/ops.md` the same way. These are skill resources, not workspace
files. Read the applicable reference completely before constructing the
spec or ops; examples in this file do not replace that reference.

## Before you build anything

**`inspect` first.** You get the page count, each page's size and rotation, the
text on each page, and the form field names `fillForm` addresses.

**`inspect-only`** — the file is encrypted or unopenable. Say so and stop.

**`scanned`** in `unsupported` means no page had extractable text. The pages
still merge, rotate, split, and stamp perfectly well — that is why the surface
is still `surgical`. To read a scan, use OCR (below), not text extraction.

## Creating

```json
{"action":"create","format":"pdf","spec":{
  "preset":"narrative_proposal",
  "page":{"size":"A4","orientation":"portrait"},
  "meta":{"title":"Field Proposal","author":"Umbratic"},
  "footer":{"pageNumbers":true},
  "blocks":[{"type":"title","text":"Field Proposal"},
            {"type":"heading","level":1,"text":"Summary"},
            {"type":"paragraph","text":"The programme delivers **three** outcomes."}]}}
```

The blocks and presets are the same vocabulary as Word — see the Documents
skill and `references/spec.md`. A spec written for `docx` builds as `pdf`
unchanged; it is re-typeset, not converted, so line and page breaks differ.

Pagination is handled for you: a heading never orphans at the foot of a page,
and a table repeats its header wherever its body crosses one.

## Page work

```json
{"action":"edit","path":"reports/q3.pdf","ops":[
  {"op":"watermark","text":"DRAFT"},
  {"op":"rotate","angle":90,"pages":[1]}]}
```

Page numbers are one-based, matching what `inspect` reports and what the reader
shows. `split` needs `out` to be a folder; it writes `part-001.pdf` onward
beside it and the result says how many.

`flatten` is one-way — the field values become page content and the fields are
gone. That is what makes a filled form safe to circulate, and it is not
reversible, so only do it when the user asks to finalise.

## OCR

For a scan, a screenshot, or a photographed document, use the local OCR digest
when one is supplied in the prompt.

- Prefer embedded text when `inspect` shows the pages have any; OCR is for when
  they do not.
- The OCR Markdown is the digest you read. The OCR JSON is the auditable source:
  coordinates, page numbers, confidence, warnings.
- **Preserve uncertainty.** When a value matters — a total, a date, a name —
  say if its line was low confidence. Never silently drop uncertain text and
  never present an OCR reading as though it were typed.
- If the warnings mention columns or table-like layout, check the page evidence
  before making a strong claim about reading order.
- OCR outputs stay under `.umbratic/artifacts/ocr/` as `*.ocr.json` and
  `*.ocr.md`. Nothing is uploaded and no model is downloaded.

## Finishing

Files land in `artifacts/pdf/` unless the user gave a path.

Report: the path, the page count, `origin` and `editSurface`, any extra files a
`split` wrote, and your assumptions. Never paste the spec back at the user.
