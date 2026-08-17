---
name: Spreadsheets
description: Use to create, inspect, or edit Excel .xlsx workbooks — models, budgets, forecasts, trackers, data tables with formulas and charts, and edits to a workbook someone else sent.
---

# Spreadsheets

Everything goes through the `artifact` tool. You send JSON; the engine writes
the workbook, recalculates it, and reports what it found. Never write
`openpyxl`, `xlsxwriter`, or any other library code.

## Before you build anything

**A file the user named or attached: `inspect` it first.** Per sheet you get
dimensions, the header row, the first twenty rows, a sampled formula map,
defined names, and any cells already holding an error value.

**`inspect-only`** — encrypted, or a legacy `.xls`. Say so and stop.

**`surgical`** — a foreign workbook, or one holding a pivot table, VBA, a
Power Query connection, a slicer, or an external link. Surgical ops only. The
unsupported feature is not touched, and it still round-trips: an edit changes
what it was asked to change and leaves their charts, formats, and column widths
exactly as they were.

## Creating

```json
{"action":"create","format":"xlsx","spec":{"sheets":[{
  "name":"Assumptions",
  "columns":[{"header":"Item","width":28},{"header":"Value","format":"0.0%"}],
  "rows":[["Growth",{"v":0.05,"role":"input"}],
          ["Churn",{"f":"=1-B2","role":"calc"}]],
  "freeze":"A2",
  "namedRanges":{"growth":"B2"}}]}}
```

A cell is a bare value, or `{v}` with a format and role, or `{f}` for a formula,
or `{d}` for an ISO date. `references/spec.md` has tables, validation,
conditional formats, and charts.

## Building a model people can trust

- **Inputs, calculations, and outputs are separate, and `role` says which.**
  `input` is what a person types over. `calc` is derived. `output` is what gets
  quoted elsewhere. `total` and `header` do what they say. The colours follow
  the convention every finance model already uses — you never pick them.
- **Every derived number is a formula, never a computed literal.** A workbook
  full of hard numbers is a screenshot. If you find yourself doing arithmetic
  to fill a cell, that arithmetic belongs in the cell.
- **Assumptions live in one place and everything else points at them.** A rate
  typed into nine formulas is nine rates.
- Freeze the header row. Name the ranges a reader would want to find.
- Ground every input in the supplied material; write `[proof needed: churn]` in
  a text cell rather than inventing a number.

## Formulas

Only these evaluate, and only these may be written:

`SUM SUMIF SUMIFS COUNT COUNTA COUNTIF COUNTIFS AVERAGE AVERAGEIF AVERAGEIFS
MIN MAX ABS ROUND ROUNDUP ROUNDDOWN IF IFERROR IFNA AND OR NOT INDEX MATCH
VLOOKUP HLOOKUP XLOOKUP TEXT LEFT RIGHT MID LEN TRIM CONCAT CONCATENATE TODAY
DATE YEAR MONTH DAY EOMONTH N PMT FV PV RATE`

Anything else fails at `rows[i][j].f` with the cell that has to change. This is
not a limitation to work around — it is the set the engine can check, and a
formula nobody can check is a formula nobody should ship. Formulas already in
someone else's file are never rewritten.

## Editing

```json
{"action":"edit","path":"models/plan.xlsx","ops":[
  {"op":"setCells","sheet":"Assumptions","cells":{"B2":0.07}}]}
```

Surgical: `setCells`, `appendRows`, `insertRows`, `insertColumns`,
`deleteRows`, `deleteColumns`, `findReplace`, `addSheet`, `renameSheet`,
`setFormat`, `setFreeze`. Full surface adds `setNamedRange` and `deleteSheet`.

`insertRows` and `insertColumns` shift every reference that pointed past them,
so use them rather than rewriting formulas by hand. `findReplace` skips formula
cells, so it cannot silently rewrite a calculation.

## Finishing

Every create and edit recalculates. Read `qa[]`:

- **`formula-error`** — the cell evaluates to `#DIV/0!`, `#REF!`, `#N/A`,
  `#NAME?`, or `#VALUE!`. This is an error and the user will see it. Fix it —
  usually by guarding a divisor with `IFERROR`, or by correcting a lookup range.
- **`circular-reference`** — a formula depends on its own result. Break the loop.
- **`not-recalculated`** — a warning, not a problem. Those formulas use a
  function outside the evaluated set; their cached values were kept untouched
  and Excel will compute them on open. Do not "fix" these.

At most three rounds, and the spec or the ops must change between them.

Files land in `.umbratic/artifacts/xlsx/` unless the user gave a path.

Report: the path, `origin` and `editSurface`, rounds, remaining warnings, and
your assumptions. Never paste the spec back at the user.
