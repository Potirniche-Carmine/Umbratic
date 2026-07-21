---
name: Data Analysis
description: Use for source-grounded analysis with Python and pandas, including data inspection, cleaning, validation, summaries, joins, statistics, charts, and reproducible deliverables.
---

# Data Analysis

Use this skill for CSV, TSV, JSON, Parquet, spreadsheet exports, and other tabular datasets. Pair it with the spreadsheet skill when the requested final deliverable is an XLSX workbook.

## Workflow

1. Locate the source files and preserve them unchanged. Record the file, sheet or table, filters, units, and time period used.
2. Inspect shape, column names, inferred types, nulls, duplicates, numeric ranges, date coverage, and category cardinality before transforming data.
3. Write a reproducible Python script in the workspace for non-trivial analysis. Prefer pandas and the existing project environment; follow the Python skill for interpreter and dependency setup.
4. Normalize headers and types explicitly. Parse dates and numeric fields with deliberate error handling rather than silently coercing bad values.
5. Validate joins with key uniqueness and row-count checks. Validate aggregations against source totals where possible.
6. Separate observed facts, calculated results, assumptions, and interpretation. Report sample size and material missing-data or quality limitations.
7. Save derived tables and charts separately from source data, then rerun the script from a clean entry point before reporting results.

## Reusable pandas Pattern

```python
from pathlib import Path
import pandas as pd

SOURCE = Path("data/source.csv")
OUTPUT = Path(".umbratic/artifacts/data-analysis")
OUTPUT.mkdir(parents=True, exist_ok=True)

df = pd.read_csv(SOURCE)
print(df.shape)
print(df.dtypes.to_string())
print(df.isna().sum().sort_values(ascending=False).head(20).to_string())
print(f"duplicate_rows={df.duplicated().sum()}")

# Apply task-specific, explicit cleaning and validation here.

summary = df.describe(include="all").transpose()
summary.to_csv(OUTPUT / "summary.csv")
```

For large CSV files, inspect a small sample first, specify needed columns and dtypes, and process with `chunksize` when full in-memory loading is unsafe. Use vectorized pandas operations instead of row loops unless the dataset is small and clarity materially improves.

## Charts And Statistics

- Choose the simplest chart that answers the question. Label axes, units, date ranges, sample sizes, and sources.
- Do not imply causation from correlation or observational comparisons.
- State the statistical method, grouping, exclusions, and uncertainty when significance or forecasting matters.
- Check for leakage, class imbalance, outliers, and unstable small groups before modeling or ranking.

## Outputs

- Keep generated analysis artifacts under `.umbratic/artifacts/data-analysis/` unless the user requests another path.
- Prefer CSV or Parquet for derived tables, PNG or SVG for charts, and a short Markdown summary for methods and findings.
- Never overwrite source data unless the user explicitly asks for an in-place correction and a recoverable copy exists.
