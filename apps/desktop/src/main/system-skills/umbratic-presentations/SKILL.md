---
name: Presentations
description: Use to create, inspect, or edit PowerPoint .pptx decks — slide copy, speaker notes, charts, tables, KPI slides, board and sales decks, and edits to a deck someone else sent.
---

# Presentations

Everything goes through the `artifact` tool. You send JSON; the engine writes
the file and checks it. Never write `pptxgenjs`, `python-pptx`, or any other
library code, and never shell out to PowerPoint or LibreOffice — there is
nothing to shell out to.

## Before you build anything

**A file the user named or attached: `inspect` it first.** The result tells you
three things you cannot guess:

- `origin` — `umbratic` if we made it, `foreign` if it is theirs.
- `editSurface` — `full`, `surgical`, or `inspect-only`.
- `outline` — the slide numbers and shape names every `edit` op addresses.

Ids you did not read out of an outline do not exist. Do not count slides
yourself and do not invent shape names.

**`inspect-only`** means encrypted, or a legacy `.ppt`. Say so and stop. Offer
to build a new deck instead; do not try ops.

**`surgical`** means a foreign deck, or one holding SmartArt, OLE, animation, or
embedded media. Use only the surgical ops. Do not restyle it, do not renumber
it, and do not duplicate a slide the `unsupported` list names — cloning those
parts produces a deck PowerPoint offers to repair.

If the user wants their brand applied to something new, that is
`create` with `template: {path, mode: "reuse"}`, not an edit. Reuse copies their
theme, masters, and layouts and fills new slides into them.

## Creating

```json
{"action":"create","format":"pptx","spec":{
  "theme":{"preset":"clean-light","accent":"#2F6FD0"},
  "slides":[
    {"layout":"title","title":"Q3 Review","subtitle":"EMEA","notes":"Open with ARR."},
    {"layout":"bullets","title":"Highlights","bullets":["Revenue up **12%**"]}
  ]}}
```

Ten layouts: `title`, `section`, `bullets`, `two-column`, `image`, `chart`,
`table`, `kpis`, `quote`, `closing`. Three themes: `clean-light`, `clean-dark`,
`warm`. See `references/spec.md` for every field and limit.

Geometry is fixed per layout, so you never send a coordinate, a colour, or a
point size — and nothing can overlap or fall off a slide. Inline `**bold**`,
`*italic*`, and `` `code` `` work in any text.

The limits are the deck's design, not an obstacle: **six bullets a slide, ninety
characters a bullet, sixty a title.** Hitting one means the slide has two ideas
in it. Split it.

## Writing the deck

- **One message per slide.** The title says the point; the bullets support it.
  A title that names a topic ("Revenue") wastes the line — say what about it
  ("Revenue grew 12% on renewals").
- **Detail belongs in `notes`.** Notes are unlimited and are what the presenter
  actually says. A slide dense enough to read is a slide nobody listens to.
- **Ground every number in what the user gave you or in a page you fetched this
  turn.** If a figure is in neither, write `[proof needed: Q3 churn]` rather
  than a plausible number. A deck that invents one number cannot be trusted on
  any of them.
- Two lines of plan first — audience, purpose, outline. Ask at most one
  question, and only if the answer changes the deck. Otherwise state your
  assumptions in the closing slide.

## Editing

```json
{"action":"edit","path":"decks/board.pptx","ops":[
  {"op":"replaceText","slide":3,"shape":"Title 1","text":"Revised outlook"}]}
```

Surgical set: `replaceText`, `setBullets`, `setNotes`, `replaceImage`,
`setChartData`, `setTable`, `findReplace`, `duplicateSlide`, `moveSlide`,
`deleteSlide`. Full surface adds `insertSlide`. `references/ops.md` has the
arguments.

One bad op discards the whole batch, so a failure leaves the file untouched.

## Finishing

A result carries `qa[]`. **Fix every `error`; judge each `warning`.** Then call
again — at most three rounds, and the spec or the ops must change between them.
The recurring error is `text-overflow`, and the fix is always the same: shorten
it or split the slide.

Files land in `.umbratic/artifacts/pptx/` unless the user gave a path.

Report: the path, `origin` and `editSurface`, how many rounds it took, any
warning you decided to leave, and every assumption you made. Never paste the
spec back at the user.
