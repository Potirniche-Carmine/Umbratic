---
name: Documents
description: Use to create, inspect, or edit Word .docx documents — briefs, memos, proposals, reference guides, contracts, forms, redlines with tracked changes, and comments on a document someone else sent.
---

# Documents

Everything goes through the `artifact` tool. You send JSON; the engine writes
the file and checks it. Never write `docx`, `python-docx`, or any other library
code, and never shell out to Word or LibreOffice.

## Before you build anything

**A file the user named or attached: `inspect` it first.** It returns `origin`,
`editSurface`, and an `outline` whose block ids every `edit` op addresses —
along with the document's `placeholders`, its `comments`, and any tracked
changes already in it.

Block ids come in two kinds and the outline says which. An `anchored` id came
from a bookmark and survives insertions above it. An unanchored one is
positional and is only good until the document changes — re-inspect after an
op that moved things.

**`inspect-only`** — encrypted or a legacy `.doc`. Say so, stop, offer to build
a new document.

**`surgical`** — a foreign document, or one holding content controls, VML
drawings, mail-merge fields, or a macro. Surgical ops only. Do not restyle, do
not renumber headings, do not rewrite blocks.

## Creating

```json
{"action":"create","format":"docx","spec":{
  "preset":"standard_business_brief",
  "page":{"size":"Letter","orientation":"portrait"},
  "meta":{"title":"Q3 Brief","author":"Umbratic"},
  "footer":{"pageNumbers":true},
  "toc":true,
  "blocks":[
    {"type":"title","text":"Q3 Brief","subtitle":"EMEA"},
    {"type":"heading","level":1,"text":"Summary"},
    {"type":"paragraph","text":"Revenue grew **12%**."},
    {"type":"table","columns":["Region","Growth"],
     "rows":[["EMEA","12%"],["Americas","8%"]]},
    {"type":"callout","style":"note","text":"Forecasts remain provisional."}
  ]}}
```

Five presets, and the choice is about how the document is read:
`standard_business_brief` (read once, on a screen), `compact_reference_guide`
(kept open beside the work), `narrative_proposal` (front to back, serif),
`simple_word_default` (familiar), `form_or_questionnaire` (printed and filled
in).

Fifteen block types — `title`, `heading`, `paragraph`, `bullets`, `numbered`,
`checklist`, `definitions`, `callout`, `table`, `image`, `chart`, `quote`,
`pageBreak`, `signature`, `formField`. `references/spec.md` has every field.

Tables use `columns`, an array of header strings or `{header, width, align}`
objects, and `rows`, an array of string arrays with one cell per column.
Callouts are separate blocks with `style` and `text`. When converting an
existing document, preserve its content, headings, lists, and tables.

The preset owns all typography. You never send a font, a size, a margin, or a
colour. A document has exactly one `title`; everything else is a `heading`.

Headings are real Word heading styles, so the navigation pane and the `toc`
field work. Set `toc: true` only when the document has headings.

## Writing the document

- **Lead with the answer.** A brief whose first paragraph is background is a
  brief nobody finishes. Recommendation first, then why.
- **Ground every number in the supplied material or a page you fetched this
  turn.** Write `[proof needed: renewal rate]` rather than a plausible figure.
- Use `callout` for the two or three things that must not be missed —
  `decision`, `warning`, `note`, `summary`. A document where everything is
  called out has nothing called out.
- Use `{{placeholders}}` for anything the user will fill later; `inspect`
  reports them by name and `fillPlaceholders` fills them.

## Editing

```json
{"action":"edit","path":"docs/contract.docx",
 "options":{"tracked":true,"author":"Umbratic"},
 "ops":[{"op":"replaceText","find":"net 30","replace":"net 45","tracked":true}]}
```

Surgical set: `replaceText`, `addComment`, `fillPlaceholders`, `setMetadata`,
`insertAfter`, `deleteBlock`. Full surface adds `replaceBlock`, `setHeading`,
`acceptAllChanges`, `rejectAllChanges`.

**`tracked: true` only when the user asked for a redline** — "track changes",
"redline", "mark up", "suggest edits". It writes real revision marks with your
author name and date, which a reviewer can accept or reject in Word. Without it
the text simply changes.

`acceptAllChanges` and `rejectAllChanges` are for finalising, and only when the
user says to finalise. Never resolve someone else's revisions on your own
initiative.

Search matches what the reader sees: runs are coalesced first, so a phrase Word
split across three runs still matches.

## Finishing

Fix every `qa` error; judge each warning. At most three rounds. The common
warnings are `narrow-column` (a table column narrower than its longest word)
and `empty-section` (a heading with nothing under it).

Files land in `.umbratic/artifacts/docx/` unless the user gave a path.

Report: the path, `origin` and `editSurface`, rounds, remaining warnings, and
your assumptions. If you wrote a redline, say how many revisions and under whose
name. Never paste the spec back at the user.
