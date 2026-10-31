# XLSX spec

Read before constructing an `artifact` create spec. The top-level object is
`{"sheets":[...]}`. Every sheet has a unique `name` of at most 31 characters;
names cannot contain `: \ / ? * [ ]`.

```json
{"sheets":[{
  "name":"Budget",
  "columns":[{"header":"Item","width":28},{"header":"Amount","format":"0.00"}],
  "rows":[["Hosting",{"v":100,"role":"input"}],
          ["Support",{"v":200,"role":"input"}],
          ["Total",{"f":"=SUM(B2:B3)","role":"total"}]],
  "freeze":"A2",
  "namedRanges":{"hosting":"B2"}
}]}
```

Column headers occupy row 1 when `columns` is present; `rows` then starts at
row 2. Without columns, rows start at row 1. Do not repeat headers in rows.

## Sheet fields

| Field | Shape |
| --- | --- |
| `name` | Required sheet name |
| `columns` | Header strings or `{header, width?, format?}`; width in characters, 1–255 |
| `rows` | Array of row arrays containing cells |
| `table` | `{name, style}`; for example `{"name":"BudgetTable","style":"medium2"}` |
| `freeze` | First unfrozen cell, for example `A2` |
| `namedRanges` | Object mapping names to cell/range references |
| `validation` | Array of `{range, type, min?, max?, values?}`; type `decimal`, `whole`, `list`, `date`, or `textLength`; list values are strings |
| `conditional` | Array of `{range, rule:"cellIs", operator, value, style}`; operator `greaterThan`, `lessThan`, `equal`, or `notEqual`; style `good`, `bad`, or `neutral` |
| `charts` | Array of `{type, title?, categories, series, anchor?}`; type `bar`, `column`, `line`, `pie`, or `scatter`; categories is a range; series is an array of `{name, values}` with values a range; anchor defaults to `E2` |

## Cells

A cell is a number, string, boolean, null, or an object with one of:

- `v`: literal number, string, boolean, or null.
- `f`: formula string, for example `=SUM(B2:B3)`.
- `d`: ISO date string, for example `2026-01-31`.

Cell objects may also carry a number `format` string and a `role`: `input`,
`calc`, `output`, `total`, or `header`. Use formulas for derived values and
only the functions listed in SKILL.md. Literal strings beginning with `=`
are not a substitute for a formula object.

## Bounds

At most 24 sheets, 20,000 data rows per sheet, 200 columns per sheet, and
2,000 characters in bounded metadata text fields. Split a larger workbook
into smaller outputs rather than exceeding the limits.
