//! Recalculation and the findings it produces.
//!
//! The rule this module exists to enforce: never write a guessed number over
//! Excel's own cached value. Every formula is evaluated, and the outcome is one
//! of three things. A clean value confirms the workbook computes. An Excel
//! error value — `#DIV/0!`, `#REF!`, `#N/A` — is a QA error, because the file
//! will show that error to the user and they cannot see why. A formula this
//! engine cannot evaluate is a warning, the cached value stays exactly as it
//! was, and the finding says so rather than pretending the cell is fine.

use std::collections::BTreeMap;

use calamine::{Data, Reader, Xlsx};
use serde::Serialize;

use crate::formula::{CellRef, Evaluator, Sheet, Value, address_of};

#[derive(Debug, Clone, Serialize)]
pub struct QaFinding {
    pub severity: String,
    #[serde(rename = "where")]
    pub location: String,
    pub kind: String,
    pub message: String,
    pub fix: String,
}

/// One sheet's cells and formulas, read out of the file so the evaluator can
/// walk them without knowing anything about xlsx.
struct WorkbookSheet {
    values: BTreeMap<(u32, u32), Value>,
    formulas: BTreeMap<(u32, u32), String>,
    name: String,
}

impl Sheet for WorkbookSheet {
    fn value_at(&self, reference: &CellRef) -> Value {
        self.values
            .get(&(reference.row, reference.column))
            .cloned()
            .unwrap_or(Value::Empty)
    }
    fn formula_at(&self, reference: &CellRef) -> Option<String> {
        // A reference into another sheet is not followed: this evaluator holds
        // one sheet at a time, and following it would need the whole workbook
        // in memory at once for a check that is per-sheet anyway.
        if reference
            .sheet
            .as_deref()
            .is_some_and(|name| name != self.name)
        {
            return None;
        }
        self.formulas
            .get(&(reference.row, reference.column))
            .cloned()
    }
}

pub struct RecalcOutcome {
    pub findings: Vec<QaFinding>,
    pub formula_count: usize,
    pub evaluated: usize,
}

pub fn recalculate(bytes: &[u8]) -> Result<RecalcOutcome, String> {
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut workbook: Xlsx<_> = Xlsx::new(cursor)
        .map_err(|error| format!("the workbook could not be reopened: {error}"))?;

    let mut findings = Vec::new();
    let mut formula_count = 0usize;
    let mut evaluated = 0usize;
    let mut unevaluable: BTreeMap<String, usize> = BTreeMap::new();

    for name in workbook.sheet_names().to_vec() {
        let Ok(range) = workbook.worksheet_range(&name) else {
            continue;
        };
        let formulas = workbook.worksheet_formula(&name).ok();
        let (row_origin, column_origin) = range.start().unwrap_or((0, 0));

        let mut values = BTreeMap::new();
        for (row_index, row) in range.rows().enumerate() {
            for (column_index, cell) in row.iter().enumerate() {
                let key = (
                    row_index as u32 + row_origin,
                    column_index as u32 + column_origin,
                );
                values.insert(key, from_calamine(cell));
            }
        }

        let mut formula_map = BTreeMap::new();
        if let Some(range) = &formulas {
            let (row_origin, column_origin) = range.start().unwrap_or((0, 0));
            for (row_index, row) in range.rows().enumerate() {
                for (column_index, text) in row.iter().enumerate() {
                    if text.is_empty() {
                        continue;
                    }
                    formula_map.insert(
                        (
                            row_index as u32 + row_origin,
                            column_index as u32 + column_origin,
                        ),
                        text.clone(),
                    );
                }
            }
        }
        formula_count += formula_map.len();

        let sheet = WorkbookSheet {
            values,
            formulas: formula_map.clone(),
            name: name.clone(),
        };
        let mut evaluator = Evaluator::new(&sheet);
        for (row, column) in formula_map.keys() {
            let reference = CellRef {
                sheet: Some(name.clone()),
                row: *row,
                column: *column,
            };
            let address = address_of(&reference);
            match evaluator.value(&reference) {
                Value::Error("#UNEVALUATED!") => {
                    *unevaluable.entry(name.clone()).or_default() += 1;
                }
                Value::Error("#CIRCULAR!") => findings.push(QaFinding {
                    severity: "error".into(),
                    location: format!("{name}!{address}"),
                    kind: "circular-reference".into(),
                    message: "the formula depends on its own result".into(),
                    fix: "break the loop".into(),
                }),
                Value::Error(code) => {
                    evaluated += 1;
                    findings.push(QaFinding {
                        severity: "error".into(),
                        location: format!("{name}!{address}"),
                        kind: "formula-error".into(),
                        message: format!(
                            "={} evaluates to {code}",
                            formula_map
                                .get(&(*row, *column))
                                .cloned()
                                .unwrap_or_default()
                        ),
                        fix: match code {
                            "#DIV/0!" => "guard the divisor with IF or IFERROR".into(),
                            "#REF!" => "the formula points outside its range".into(),
                            "#N/A" => "the lookup found no match".into(),
                            "#NAME?" => "a function or name in the formula is not defined".into(),
                            _ => "check the formula's inputs".into(),
                        },
                    });
                }
                _ => evaluated += 1,
            }
        }

        // Error values already sitting in the file, which a formula we cannot
        // evaluate would otherwise hide.
        for (position, value) in &sheet.values {
            if formula_map.contains_key(position) {
                continue;
            }
            if let Value::Error(code) = value {
                findings.push(QaFinding {
                    severity: "error".into(),
                    location: format!(
                        "{name}!{}",
                        address_of(&CellRef {
                            sheet: None,
                            row: position.0,
                            column: position.1
                        })
                    ),
                    kind: "error-value".into(),
                    message: format!("the cell holds {code}"),
                    fix: "fix the formula that produced it, or clear the cell".into(),
                });
            }
        }
    }

    for (sheet, count) in unevaluable {
        findings.push(QaFinding {
            severity: "warning".into(),
            location: sheet,
            kind: "not-recalculated".into(),
            message: format!(
                "{count} formula{} use a function this engine does not evaluate; their cached values were kept",
                if count == 1 { "" } else { "s" }
            ),
            fix: "none; open the file in Excel to see their current values".into(),
        });
    }

    Ok(RecalcOutcome {
        findings,
        formula_count,
        evaluated,
    })
}

fn from_calamine(cell: &Data) -> Value {
    match cell {
        Data::Empty => Value::Empty,
        Data::String(value) => Value::Text(value.clone()),
        Data::Float(value) => Value::Number(*value),
        Data::Int(value) => Value::Number(*value as f64),
        Data::Bool(value) => Value::Bool(*value),
        Data::DateTime(value) => Value::Number(value.as_f64()),
        Data::DateTimeIso(value) => Value::Text(value.clone()),
        Data::DurationIso(value) => Value::Text(value.clone()),
        Data::Error(error) => Value::Error(match format!("{error:?}").as_str() {
            "Div0" => "#DIV/0!",
            "NA" => "#N/A",
            "Name" => "#NAME?",
            "Null" => "#NULL!",
            "Num" => "#NUM!",
            "Ref" => "#REF!",
            "Value" => "#VALUE!",
            _ => "#ERROR!",
        }),
    }
}

/// Checks that what was written matches what the spec asked for.
///
/// A writer that silently dropped a sheet or a column would otherwise produce
/// a perfectly valid file that is not the file anybody asked for.
pub fn check_dimensions(
    bytes: &[u8],
    expected: &[(String, usize, usize)],
) -> Result<Vec<QaFinding>, String> {
    let inspection = crate::inspect::inspect_workbook(bytes)?;
    let mut findings = Vec::new();
    for (name, rows, columns) in expected {
        let Some(sheet) = inspection
            .outline
            .sheets
            .iter()
            .find(|sheet| &sheet.name == name)
        else {
            findings.push(QaFinding {
                severity: "error".into(),
                location: name.clone(),
                kind: "missing-sheet".into(),
                message: "the spec asked for this sheet but the file does not have it".into(),
                fix: "rebuild".into(),
            });
            continue;
        };
        // Trailing empty rows and columns are trimmed by the format itself, so
        // only a shortfall is a defect.
        if sheet.rows < *rows || sheet.columns < *columns {
            findings.push(QaFinding {
                severity: "error".into(),
                location: name.clone(),
                kind: "dimension-mismatch".into(),
                message: format!(
                    "the spec described {rows}×{columns} but the sheet holds {}×{}",
                    sheet.rows, sheet.columns
                ),
                fix: "rebuild".into(),
            });
        }
    }
    Ok(findings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{create::create_workbook, spec::read_workbook_spec};
    use serde_json::json;

    fn build(spec: serde_json::Value) -> Vec<u8> {
        let parsed = read_workbook_spec(&spec).expect("valid spec");
        create_workbook(&parsed).expect("writes").bytes
    }

    #[test]
    fn a_workbook_that_computes_reports_nothing() {
        let bytes = build(json!({
            "sheets": [{
                "name": "Model",
                "columns": [{"header": "Item"}, {"header": "Value"}],
                "rows": [["Revenue", 100], ["Cost", 40], ["Margin", {"f": "=B2-B3"}]]
            }]
        }));
        let outcome = recalculate(&bytes).expect("recalculates");
        assert_eq!(outcome.formula_count, 1);
        assert_eq!(outcome.evaluated, 1);
        assert!(outcome.findings.is_empty(), "{:?}", outcome.findings);
    }

    #[test]
    fn a_division_by_zero_is_reported_where_it_is_with_the_fix() {
        let bytes = build(json!({
            "sheets": [{
                "name": "Model",
                "columns": [{"header": "Item"}, {"header": "Value"}],
                "rows": [["Revenue", 100], ["Units", 0], ["Price", {"f": "=B2/B3"}]]
            }]
        }));
        let outcome = recalculate(&bytes).expect("recalculates");
        let finding = outcome
            .findings
            .iter()
            .find(|finding| finding.kind == "formula-error")
            .expect("a division by zero should be reported");
        assert_eq!(finding.location, "Model!B4");
        assert!(finding.message.contains("#DIV/0!"));
        assert!(finding.fix.contains("IFERROR"));
    }

    #[test]
    fn a_lookup_that_finds_nothing_is_an_error_rather_than_a_silent_blank() {
        let bytes = build(json!({
            "sheets": [{
                "name": "Data",
                "columns": [{"header": "Key"}, {"header": "Value"}],
                "rows": [["a", 1], ["b", 2], ["found", {"f": "=VLOOKUP(\"zzz\",A2:B3,2)"}]]
            }]
        }));
        let outcome = recalculate(&bytes).expect("recalculates");
        assert!(
            outcome
                .findings
                .iter()
                .any(|finding| finding.message.contains("#N/A")),
            "{:?}",
            outcome.findings
        );
    }

    #[test]
    fn a_function_we_do_not_evaluate_warns_and_keeps_the_cached_value() {
        let bytes = build(json!({
            "sheets": [{
                "name": "Model",
                "columns": [{"header": "When"}],
                "rows": [[{"f": "=TODAY()"}]]
            }]
        }));
        let outcome = recalculate(&bytes).expect("recalculates");
        let finding = outcome
            .findings
            .iter()
            .find(|finding| finding.kind == "not-recalculated")
            .expect("an unevaluable formula should warn");
        assert_eq!(finding.severity, "warning");
        assert!(finding.message.contains("cached values were kept"));
        // And it is a warning, not an error: the file is fine.
        assert!(
            !outcome
                .findings
                .iter()
                .any(|finding| finding.severity == "error")
        );
    }

    #[test]
    fn dimensions_are_checked_against_what_the_spec_asked_for() {
        let bytes = build(json!({
            "sheets": [{"name": "Data", "columns": [{"header": "A"}], "rows": [[1], [2]]}]
        }));
        assert!(
            check_dimensions(&bytes, &[("Data".into(), 3, 1)])
                .expect("checks")
                .is_empty()
        );
        let findings = check_dimensions(&bytes, &[("Missing".into(), 1, 1)]).expect("checks");
        assert_eq!(findings[0].kind, "missing-sheet");
    }
}
