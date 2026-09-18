# XLSX ops

Read before constructing `artifact` edit ops. Inspect an existing workbook
first and use its actual sheet names and `editSurface`.

```json
[{"op":"setCells","sheet":"Budget","cells":{"B2":150}},
 {"op":"setFormat","sheet":"Budget","range":"B2:B4","format":"0.00"}]
```

## Surgical operations

| Op | Arguments besides `op` |
| --- | --- |
| `setCells` | `sheet`, `cells` object mapping cell addresses to values or formula strings beginning with `=` |
| `appendRows` | `sheet`, `rows` array of cell arrays |
| `insertRows`, `deleteRows` | `sheet`, `at` one-based row number, `count` (defaults to 1) |
| `insertColumns`, `deleteColumns` | `sheet`, `at` one-based column number, `count` (defaults to 1) |
| `findReplace` | `find`, `replace`, optional `sheet`; only value cells, never formulas |
| `addSheet` | `name` |
| `renameSheet` | `sheet`, `to` |
| `setFormat` | `sheet`, `range`, `format` number-format string |
| `setFreeze` | `sheet`, `at` first unfrozen cell such as `A2` |

Edits accept literal cells and formula strings such as `=SUM(B2:B3)`, not
create-spec cell objects (`{v}`, `{f}`, or `{d}`). Apply formats with `setFormat`.

## Full surface only

| Op | Arguments besides `op` |
| --- | --- |
| `setNamedRange` | `sheet`, `name`, `range` |
| `deleteSheet` | `sheet`; at least one sheet must remain |

`setValidation`, `setConditional`, and `addChart` are not implemented for
editing. Do not call them or recreate a supplied workbook to bypass that
limit. `inspect-only` permits no edits. New formulas must use the allowlist
in SKILL.md. Every edit recalculates and returns QA findings; fix errors
within the skill's three-round limit.
