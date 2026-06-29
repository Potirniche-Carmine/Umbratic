---
name: Spreadsheets
description: Use for local XLSX/Excel, CSV, TSV, workbook analysis, formulas, formatting, charts, financial models, forecasts, and rendered workbook QA.
---

# Spreadsheets Skill (Create, Edit, Analyze, Visualize)

Use this skill when working with local spreadsheet files or spreadsheet-shaped outputs:

- Create or modify `.xlsx`, `.xls`, `.csv`, or `.tsv` files.
- Build workbooks with typed values, formulas, assumptions, formatting, tables, charts, and dashboards.
- Read, inspect, clean, analyze, aggregate, pivot, or visualize tabular data.
- Recalculate formulas and verify workbook results after changes.
- Answer questions about a workbook without changing it when the user asks for analysis only.

## Scope

- This system skill is for local spreadsheet workflows only. Do not route to Google Sheets, Google Drive, browser automation, or native cloud spreadsheet APIs from this guidance.
- Use the workspace, uploaded files, user-provided data, and cited external sources as facts. Do not invent missing source data, customer claims, prices, financial metrics, or benchmark values.
- Keep generated XLSX deliverables under `.umbratic/artifacts/xlsx/` unless the user requests a specific path. Use `.umbratic/templates/spreadsheets/` only for supplied or server-selected templates.
- For existing workbooks, preserve established formulas, styles, sheet structure, defined names, protection, frozen panes, print setup, and chart/table conventions unless the requested change requires altering them.

## Runtime Contract

- Prefer the configured local XLSX JavaScript workbook runtime when it is available. Use the runtime capability guidance injected into the prompt as authoritative.
- Do not install packages, use global dependencies, or rely on undeclared repo-local packages to produce a workbook.
- If the XLSX authoring runtime is missing and the user asked for an actual `.xlsx`, state the generation gap and provide spreadsheet-ready source content: tables, formulas, chart specifications, and layout instructions.
- If LibreOffice export/render is missing, do not claim workbook visual QA. You may still inspect workbook structure and formulas, but state that render/export verification was unavailable.
- For analysis that does not require workbook authoring, use the local tools already available in the workspace. Keep calculations auditable by placing important assumptions and derived calculations in the workbook as formulas when a workbook is delivered.

## Work Planning

For complex spreadsheet work, make a short plan before authoring or editing:

1. Identify the workbook purpose, audience, source data, assumptions, output tabs, and required charts or tables.
2. Decide the sheet architecture: raw inputs, assumptions, calculations, outputs, dashboard, sources, and QA checks.
3. Define formula flow before writing: inputs feed calculations, calculations feed summaries, summaries feed charts.
4. Choose formatting conventions for inputs, formulas, outputs, dates, currencies, percentages, warnings, and source notes.
5. Build, inspect, recalculate, render/export, repair, and finalize.

## Workbook Architecture

- Use separate sheets or clearly separated sections for `Inputs`, `Assumptions`, `Data`, `Calculations`, `Summary`, `Dashboard`, `Charts`, `Sources`, and `Checks` when the task warrants them.
- Keep raw imported data intact unless the user asks for cleaning in place. Prefer a cleaned/normalized table on a separate sheet when transformations are substantial.
- Keep all key assumptions visible, labeled, and easy to update. Avoid hiding assumptions inside formulas.
- Derived values should usually be formulas, not hardcoded results. Hardcode only true source/input values or explicitly requested static outputs.
- Add a `Sources` section or source column when researched or extracted data is used.
- Avoid unnecessary sheets, decorative dashboards, and over-modeled structures for simple tasks.

## Editing Existing Workbooks

Before modifying an existing workbook:

- Inspect relevant sheets, values, formulas, dimensions, formats, tables, named ranges, charts, filters, hidden rows/columns, merged cells, comments, and protection settings.
- Render or export the relevant sheet/range when visual fidelity matters, then match the existing style and layout.
- Read neighboring formulas before inserting rows/columns or extending tables so formulas remain consistent.
- Preserve the workbook's established color, font, number format, border, alignment, freeze pane, and print/page conventions.
- Start with the smallest local edit that satisfies the request. Do not apply sheet-wide autofit, wrapping, restyling, or formula rewrites unless needed.

When adding rows, columns, or periods:

- Extend formulas, tables, structured references, totals, conditional formatting, data validation, named ranges, print areas, filters, and charts as needed.
- Keep formulas consistent across comparable rows/columns.
- Verify all dependent summaries and charts update correctly.
- Keep historical periods, actuals, forecasts, assumptions, and scenarios clearly labeled.

## Formula Rules

- Keep formulas simple, legible, and auditable. Use helper rows/cells for intermediate logic instead of one dense formula.
- Do not put hardcoded constants inside calculation formulas. Put constants in named assumption cells or clearly labeled input cells and reference them.
- Use correct absolute and relative references for fill behavior.
- Prefer consistent formula patterns across a range. If a formula must differ, make the reason visible in a label, note, or comment.
- Reference other sheets with quoted sheet names, for example `='Assumptions'!B4`, especially when names contain spaces or special characters.
- Use formulas for totals, subtotals, ratios, CAGR, variance, YoY growth, margins, rates, and derived dates when inputs can change.
- Handle edge cases deliberately: zero denominators, blanks, negative values, missing dates, and partial periods.
- For important assumptions or complex formulas, add comments or nearby notes that explain the source and intent.

Formula QA checklist:

- No `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#N/A`, unintended circular references, or broken links in key ranges.
- Ranges include the intended first and last row/column; no off-by-one errors.
- Totals reconcile to visible detail where applicable.
- Cross-sheet references target the expected sheets and cells.
- Scenario, sensitivity, and forecast formulas switch correctly when assumptions change.

## Data Formatting Rules

- Store numbers, percentages, currencies, dates, booleans, and times as typed spreadsheet values, not preformatted text.
- Use text only for true identifiers such as ZIP codes, account IDs, SKUs, invoice numbers, and labels.
- Use Excel-invariant number/date formats: `#,##0`, `#,##0.0`, `0.0%`, `0.00%`, `"$"#,##0`, `"$"#,##0.00`, `yyyy-mm-dd`, `mmm yyyy`.
- Do not swap `.` and `,` in format codes to mimic locale separators. Spreadsheet locale controls separators.
- Match precision to meaning: counts use whole numbers, rates usually use one decimal, small rate differences may use two decimals, currency usually uses whole units unless cents matter.
- Use negative number formats intentionally, especially in financial models and variance analyses.
- Keep dates as serial dates with visible date formats, not strings.
- Avoid overly wide columns and oversized row heights. After autofit or wrapping, cap columns and rows that become impractical.

## Styling Rules

- Make the workbook easy to scan, update, and audit. Use clear titles, section labels, frozen headers, consistent indentation, and restrained color.
- Use a visible convention for inputs, assumptions, calculations, outputs, linked/source values, and checks.
- Avoid heavy borders everywhere. Use borders to define table headers, totals, and major sections.
- Use fill colors sparingly for hierarchy, status, and input areas. Ensure contrast is readable.
- Keep dashboard outputs concise and user-facing. Do not bury the main answer in raw data.
- Do not overwrite established formatting in existing workbooks unless requested or necessary to extend an existing pattern.

## Tables, Filters, and Validation

- Use stable column names, short headers, typed values, and one record per row.
- Avoid merged cells inside data tables. Use merged cells only for intentional titles or section headers.
- Preserve filters, freeze panes, hidden helper columns, and protected cells where they serve the workbook.
- Use data validation for controlled inputs such as scenario selectors, categories, statuses, dates, or yes/no fields.
- For output tables, include totals, subtotals, and units where useful.

## Charts and Visuals

Create or edit charts when they help answer the question faster than a table.

- Choose chart types based on the relationship: line for trends, bar/column for comparisons, stacked bars for composition, scatter for correlation, waterfall for bridge analysis, combo charts for mixed scale measures.
- Use concise titles, readable axis labels, appropriate number formats, and clear legends.
- Avoid chartjunk, 3D charts, unreadable rotated labels, dense color palettes, and misleading axis scales.
- Verify chart ranges include newly added rows/columns and exclude blanks, helper rows, and unrelated totals unless intentionally shown.
- Render/export charts when possible and check for blank charts, clipped labels, unreadable legends, or broken references.

## Analysis Guidance

When analyzing data:

- Keep source data and transformed data distinguishable.
- Document filters, exclusions, joins, groupings, and assumptions.
- Use formulas, pivot-style summaries, or clearly labeled calculations that a user can audit.
- Include QA checks for row counts, totals before/after cleaning, unmatched records, duplicate keys, missing values, and outliers.
- Answer the user's actual question. Do not make workbook edits when they only asked for an explanation or insight.

## Screenshot and Image Extraction

When recreating or extracting from a screenshot/reference image:

- Store visible numbers and dates as typed values with appropriate formats, not strings that only look right.
- Preserve numeric usability even when the screenshot shows locale-specific punctuation or currency symbols.
- Separate source/input values from clearly derived values.
- Test adjacent rows/columns for repeated relationships such as sums, differences, products, ratios, rates, and constant multiples. Use formulas for derived ranges when the pattern is clear.
- Match visible styling only where it is intentional. Do not infer exact font weights, colors, or dimensions from compression, zoom, or antialiasing artifacts.

## Domain Defaults

Finance and investment banking:

- Use separate sheets or sections for assumptions, historicals, projections, outputs, and checks.
- Color-code hardcoded inputs, formulas, linked/source values, and outputs consistently.
- Keep model formulas auditable. Avoid complex nested formulas when helper rows improve traceability.
- Cite model-input sources in comments or a source column.
- Include checks for balance, cash flow, roll-forward, debt schedule, share count, and sign conventions when relevant.

Corporate finance and FP&A:

- Clearly separate actuals, budget, forecast, variance, and scenarios.
- Use calendar/fiscal period labels consistently.
- Include variance dollars, variance percentages, and explanations where relevant.
- Preserve planning granularity and rollups.

Marketing and advertising:

- Preserve campaign, channel, audience, spend, impressions, clicks, conversions, CAC/CPA, ROAS, and date dimensions.
- Use rate formulas for CTR, CVR, CPC, CPM, CPA, and ROAS rather than hardcoded outputs.
- Show sources and attribution windows when supplied.

Healthcare, scientific, or regulated data:

- Keep identifiers, dates, units, cohorts, and exclusions explicit.
- Do not infer protected or sensitive values.
- Include source, inclusion/exclusion, and calculation notes where needed.

## Error Recovery

On the first workbook API or runtime error:

1. Read the exact error text.
2. Patch the smallest failing block rather than rewriting the workbook.
3. Retry once with the corrected API usage or simplified feature.
4. If the same capability is still unavailable, state the limitation and provide the best auditable fallback.

Do not loop indefinitely on similar failures.

## Verification

Before finalizing a workbook, verify both structure and visual quality.

Inspect key ranges:

- Important inputs and assumptions.
- Formula ranges and totals.
- Summary/dashboard outputs.
- Source/citation rows.
- Any area you edited.

Scan for formula errors:

- Search key sheets for `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#N/A`, `#NUM!`, and broken external links.
- Check formulas in first, middle, and last rows/columns of repeated ranges.
- Recalculate using the configured runtime or LibreOffice when available.

Render/export visual output when possible:

- Export or render every user-facing sheet, dashboard, and chart.
- Check that titles, labels, numbers, charts, and callouts are visible.
- Fix blank/broken charts, clipped headers or numbers, unreadable colors, awkward wrapping, excessive blank space, default blank sheets, and content outside the visible working area.
- If render/export is unavailable, state the verification gap and summarize structural checks performed.

Completion criteria:

- Workbook content is populated and formulas compute.
- Key formula ranges are free of obvious errors.
- Layout is organized, legible, and aligned to the request or existing workbook style.
- Final `.xlsx` is saved under `.umbratic/artifacts/xlsx/` unless directed otherwise.
- Support files, logs, screenshots, and builders are not presented as final deliverables unless requested.

## Final Response

- Summarize only the final user-visible result and any verification gap.
- Link only final `.xlsx`, `.csv`, or `.tsv` deliverables unless the user asks for support files.
- If no spreadsheet runtime was available, provide the spreadsheet-ready fallback and state that an `.xlsx` could not be generated in the current environment.
