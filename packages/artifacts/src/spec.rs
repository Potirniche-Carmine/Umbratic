//! The workbook spec: what a model may ask for, and the errors it gets back.
//!
//! Same contract as the other formats — every failure carries a JSON path into
//! the spec that was just sent, so a repair is one edit rather than a
//! re-derivation. The one rule specific to spreadsheets is the formula
//! allowlist: a formula outside it is refused here, at `rows[i][j].f`, rather
//! than written and discovered later by a recalculation that cannot read it.

use serde_json::Value as Json;

use crate::formula::{self, ParseError};

#[derive(Debug, Clone, serde::Serialize)]
pub struct SpecError {
    pub path: String,
    pub message: String,
}

pub const MAX_SHEETS: usize = 24;
pub const MAX_ROWS: usize = 20_000;
pub const MAX_COLUMNS: usize = 200;
pub const MAX_TEXT: usize = 2_000;

/// What a cell's contents mean for colouring. The finance convention: an input
/// is what a person types, a calc is derived, an output is what gets quoted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellRole {
    Input,
    Calc,
    Output,
    Total,
    Header,
}

impl CellRole {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "input" => Some(Self::Input),
            "calc" => Some(Self::Calc),
            "output" => Some(Self::Output),
            "total" => Some(Self::Total),
            "header" => Some(Self::Header),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum CellValue {
    Number(f64),
    Text(String),
    Bool(bool),
    /// An ISO date, kept as text until the writer turns it into a serial.
    Date(String),
    Formula(String),
    Empty,
}

#[derive(Debug, Clone)]
pub struct Cell {
    pub value: CellValue,
    pub format: Option<String>,
    pub role: Option<CellRole>,
}

#[derive(Debug, Clone)]
pub struct Column {
    pub header: String,
    pub width: Option<f64>,
    pub format: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Validation {
    pub range: String,
    pub kind: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub list: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Conditional {
    pub range: String,
    pub rule: String,
    pub operator: String,
    pub value: f64,
    pub style: String,
}

#[derive(Debug, Clone)]
pub struct Chart {
    pub kind: String,
    pub title: Option<String>,
    pub categories: String,
    pub series: Vec<(String, String)>,
    pub anchor: String,
}

#[derive(Debug, Clone)]
pub struct SheetSpec {
    pub name: String,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
    pub table: Option<(String, String)>,
    pub freeze: Option<String>,
    pub named_ranges: Vec<(String, String)>,
    pub validation: Vec<Validation>,
    pub conditional: Vec<Conditional>,
    pub charts: Vec<Chart>,
}

#[derive(Debug, Clone)]
pub struct WorkbookSpec {
    pub sheets: Vec<SheetSpec>,
}

struct Reader {
    errors: Vec<SpecError>,
}

impl Reader {
    fn fail(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.errors.push(SpecError {
            path: path.into(),
            message: message.into(),
        });
    }

    fn text(&mut self, value: Option<&Json>, path: &str, required: bool) -> Option<String> {
        match value {
            None | Some(Json::Null) => {
                if required {
                    self.fail(path, "is required");
                }
                None
            }
            Some(Json::String(text)) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    if required {
                        self.fail(path, "must not be empty");
                    }
                    return None;
                }
                if trimmed.chars().count() > MAX_TEXT {
                    self.fail(
                        path,
                        format!("is {} characters; max {MAX_TEXT}", trimmed.chars().count()),
                    );
                    return None;
                }
                Some(trimmed.to_owned())
            }
            Some(_) => {
                self.fail(path, "must be a string");
                None
            }
        }
    }
}

pub fn read_workbook_spec(input: &Json) -> Result<WorkbookSpec, Vec<SpecError>> {
    let mut reader = Reader { errors: Vec::new() };
    let Some(object) = input.as_object() else {
        return Err(vec![SpecError {
            path: "spec".into(),
            message: "must be an object".into(),
        }]);
    };
    let Some(sheets) = object.get("sheets").and_then(Json::as_array) else {
        return Err(vec![SpecError {
            path: "sheets".into(),
            message: "must be an array of sheet objects".into(),
        }]);
    };
    if sheets.is_empty() {
        return Err(vec![SpecError {
            path: "sheets".into(),
            message: "must contain at least one sheet".into(),
        }]);
    }
    if sheets.len() > MAX_SHEETS {
        return Err(vec![SpecError {
            path: "sheets".into(),
            message: format!("has {} sheets; max {MAX_SHEETS}", sheets.len()),
        }]);
    }

    let mut parsed = Vec::new();
    for (index, sheet) in sheets.iter().enumerate() {
        parsed.push(read_sheet(&mut reader, sheet, &format!("sheets[{index}]")));
    }

    // Excel refuses a workbook with two sheets of the same name, and the error
    // it shows is about a corrupt file rather than about the name.
    let mut seen: Vec<&str> = Vec::new();
    for (index, sheet) in parsed.iter().enumerate() {
        if seen.contains(&sheet.name.as_str()) {
            reader.fail(
                format!("sheets[{index}].name"),
                format!(
                    "{} is used by an earlier sheet; names must be unique",
                    sheet.name
                ),
            );
        }
        seen.push(&sheet.name);
    }

    if reader.errors.is_empty() {
        Ok(WorkbookSpec { sheets: parsed })
    } else {
        Err(reader.errors)
    }
}

fn read_sheet(reader: &mut Reader, value: &Json, path: &str) -> SheetSpec {
    let Some(object) = value.as_object() else {
        reader.fail(path, "must be an object");
        return empty_sheet();
    };
    let name = reader
        .text(object.get("name"), &format!("{path}.name"), true)
        .unwrap_or_else(|| "Sheet1".into());
    // Excel's own rules, and breaking any of them makes the file unopenable
    // rather than merely odd.
    if name.chars().count() > 31 {
        reader.fail(
            format!("{path}.name"),
            format!("is {} characters; Excel allows 31", name.chars().count()),
        );
    }
    if name.contains([':', '\\', '/', '?', '*', '[', ']']) {
        reader.fail(format!("{path}.name"), r#"cannot contain : \ / ? * [ or ]"#);
    }

    let mut columns = Vec::new();
    if let Some(list) = object.get("columns") {
        match list.as_array() {
            None => reader.fail(format!("{path}.columns"), "must be an array"),
            Some(entries) => {
                if entries.len() > MAX_COLUMNS {
                    reader.fail(
                        format!("{path}.columns"),
                        format!("has {} columns; max {MAX_COLUMNS}", entries.len()),
                    );
                }
                for (index, entry) in entries.iter().enumerate() {
                    let column_path = format!("{path}.columns[{index}]");
                    if let Some(header) = entry.as_str() {
                        columns.push(Column {
                            header: header.to_owned(),
                            width: None,
                            format: None,
                        });
                        continue;
                    }
                    let Some(fields) = entry.as_object() else {
                        reader.fail(&column_path, "must be a header string or an object");
                        continue;
                    };
                    let header = reader
                        .text(fields.get("header"), &format!("{column_path}.header"), true)
                        .unwrap_or_default();
                    let width = fields.get("width").and_then(Json::as_f64).filter(|value| {
                        if *value <= 0.0 || *value > 255.0 {
                            reader.fail(
                                format!("{column_path}.width"),
                                "must be between 1 and 255 characters",
                            );
                            false
                        } else {
                            true
                        }
                    });
                    let format = fields
                        .get("format")
                        .and_then(Json::as_str)
                        .map(str::to_owned);
                    columns.push(Column {
                        header,
                        width,
                        format,
                    });
                }
            }
        }
    }

    let mut rows: Vec<Vec<Cell>> = Vec::new();
    if let Some(list) = object.get("rows") {
        match list.as_array() {
            None => reader.fail(format!("{path}.rows"), "must be an array of row arrays"),
            Some(entries) => {
                if entries.len() > MAX_ROWS {
                    reader.fail(
                        format!("{path}.rows"),
                        format!("has {} rows; max {MAX_ROWS}", entries.len()),
                    );
                }
                for (row_index, row) in entries.iter().take(MAX_ROWS).enumerate() {
                    let row_path = format!("{path}.rows[{row_index}]");
                    let Some(cells) = row.as_array() else {
                        reader.fail(&row_path, "must be an array of cells");
                        continue;
                    };
                    if cells.len() > MAX_COLUMNS {
                        reader.fail(
                            &row_path,
                            format!("has {} cells; max {MAX_COLUMNS}", cells.len()),
                        );
                        continue;
                    }
                    rows.push(
                        cells
                            .iter()
                            .enumerate()
                            .map(|(cell_index, cell)| {
                                read_cell(reader, cell, &format!("{row_path}[{cell_index}]"))
                            })
                            .collect(),
                    );
                }
            }
        }
    }

    let table = object.get("table").and_then(Json::as_object).map(|fields| {
        (
            fields
                .get("name")
                .and_then(Json::as_str)
                .unwrap_or("Table1")
                .to_owned(),
            fields
                .get("style")
                .and_then(Json::as_str)
                .unwrap_or("medium2")
                .to_owned(),
        )
    });

    let freeze = object
        .get("freeze")
        .and_then(Json::as_str)
        .map(str::to_owned)
        .filter(|value| {
            if formula::parse_reference(value).is_none() {
                reader.fail(format!("{path}.freeze"), "must be a cell such as A2");
                false
            } else {
                true
            }
        });

    let mut named_ranges = Vec::new();
    if let Some(names) = object.get("namedRanges").and_then(Json::as_object) {
        for (name, target) in names {
            match target.as_str() {
                Some(text) => named_ranges.push((name.clone(), text.to_owned())),
                None => reader.fail(
                    format!("{path}.namedRanges.{name}"),
                    "must be a cell or range reference",
                ),
            }
        }
    }

    SheetSpec {
        name,
        columns,
        rows,
        table,
        freeze,
        named_ranges,
        validation: read_validation(reader, object.get("validation"), path),
        conditional: read_conditional(reader, object.get("conditional"), path),
        charts: read_charts(reader, object.get("charts"), path),
    }
}

fn empty_sheet() -> SheetSpec {
    SheetSpec {
        name: "Sheet1".into(),
        columns: Vec::new(),
        rows: Vec::new(),
        table: None,
        freeze: None,
        named_ranges: Vec::new(),
        validation: Vec::new(),
        conditional: Vec::new(),
        charts: Vec::new(),
    }
}

fn read_cell(reader: &mut Reader, value: &Json, path: &str) -> Cell {
    let plain = |value: CellValue| Cell {
        value,
        format: None,
        role: None,
    };
    match value {
        Json::Null => plain(CellValue::Empty),
        Json::Bool(flag) => plain(CellValue::Bool(*flag)),
        Json::Number(number) => plain(CellValue::Number(number.as_f64().unwrap_or(0.0))),
        Json::String(text) => plain(CellValue::Text(text.clone())),
        Json::Array(_) => {
            reader.fail(path, "must be a value or a {v, f, d} object, not an array");
            plain(CellValue::Empty)
        }
        Json::Object(fields) => {
            let role = fields.get("role").and_then(Json::as_str).and_then(|value| {
                match CellRole::parse(value) {
                    Some(role) => Some(role),
                    None => {
                        reader.fail(
                            format!("{path}.role"),
                            "must be one of input, calc, output, total, header",
                        );
                        None
                    }
                }
            });
            let format = fields
                .get("format")
                .and_then(Json::as_str)
                .map(str::to_owned);

            let value = if let Some(text) = fields.get("f").and_then(Json::as_str) {
                let body = text.trim().trim_start_matches('=').to_owned();
                match formula::parse(&body) {
                    Ok(_) => CellValue::Formula(body),
                    Err(ParseError::NotAllowed(name)) => {
                        reader.fail(
                            format!("{path}.f"),
                            format!(
                                "{name} is not on the allowed function list; use one of {}",
                                formula::ALLOWED_FUNCTIONS.join(" ")
                            ),
                        );
                        CellValue::Empty
                    }
                    Err(ParseError::Syntax(detail)) => {
                        reader.fail(format!("{path}.f"), format!("could not be read: {detail}"));
                        CellValue::Empty
                    }
                }
            } else if let Some(date) = fields.get("d").and_then(Json::as_str) {
                if parse_iso_date(date).is_none() {
                    reader.fail(
                        format!("{path}.d"),
                        "must be an ISO date such as 2026-01-31",
                    );
                    CellValue::Empty
                } else {
                    CellValue::Date(date.to_owned())
                }
            } else {
                match fields.get("v") {
                    Some(Json::Number(number)) => CellValue::Number(number.as_f64().unwrap_or(0.0)),
                    Some(Json::String(text)) => CellValue::Text(text.clone()),
                    Some(Json::Bool(flag)) => CellValue::Bool(*flag),
                    Some(Json::Null) | None => CellValue::Empty,
                    Some(_) => {
                        reader.fail(format!("{path}.v"), "must be a number, string, or boolean");
                        CellValue::Empty
                    }
                }
            };
            Cell {
                value,
                format,
                role,
            }
        }
    }
}

/// `2026-01-31` to a day count from 1899-12-30, which is Excel's epoch.
pub fn parse_iso_date(value: &str) -> Option<f64> {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let year: i64 = parts[0].parse().ok()?;
    let month: i64 = parts[1].parse().ok()?;
    let day: i64 = parts[2].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(1900..=9999).contains(&year) {
        return None;
    }
    // Days from the civil epoch, then shifted to Excel's serial origin.
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some((days + 25_569) as f64)
}

fn read_validation(reader: &mut Reader, value: Option<&Json>, path: &str) -> Vec<Validation> {
    let Some(entries) = value.and_then(Json::as_array) else {
        if value.is_some() {
            reader.fail(format!("{path}.validation"), "must be an array");
        }
        return Vec::new();
    };
    let mut rules = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let rule_path = format!("{path}.validation[{index}]");
        let Some(fields) = entry.as_object() else {
            reader.fail(&rule_path, "must be an object");
            continue;
        };
        let Some(range) = reader.text(fields.get("range"), &format!("{rule_path}.range"), true)
        else {
            continue;
        };
        let kind = fields
            .get("type")
            .and_then(Json::as_str)
            .unwrap_or("decimal")
            .to_owned();
        if !["decimal", "whole", "list", "date", "textLength"].contains(&kind.as_str()) {
            reader.fail(
                format!("{rule_path}.type"),
                "must be one of decimal, whole, list, date, textLength",
            );
            continue;
        }
        rules.push(Validation {
            range,
            kind,
            min: fields.get("min").and_then(Json::as_f64),
            max: fields.get("max").and_then(Json::as_f64),
            list: fields
                .get("values")
                .and_then(Json::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Json::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        });
    }
    rules
}

fn read_conditional(reader: &mut Reader, value: Option<&Json>, path: &str) -> Vec<Conditional> {
    let Some(entries) = value.and_then(Json::as_array) else {
        if value.is_some() {
            reader.fail(format!("{path}.conditional"), "must be an array");
        }
        return Vec::new();
    };
    let mut rules = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let rule_path = format!("{path}.conditional[{index}]");
        let Some(fields) = entry.as_object() else {
            reader.fail(&rule_path, "must be an object");
            continue;
        };
        let Some(range) = reader.text(fields.get("range"), &format!("{rule_path}.range"), true)
        else {
            continue;
        };
        let operator = fields
            .get("operator")
            .and_then(Json::as_str)
            .unwrap_or("greaterThan")
            .to_owned();
        if !["greaterThan", "lessThan", "equal", "notEqual", "between"].contains(&operator.as_str())
        {
            reader.fail(
                format!("{rule_path}.operator"),
                "must be one of greaterThan, lessThan, equal, notEqual, between",
            );
            continue;
        }
        let style = fields
            .get("style")
            .and_then(Json::as_str)
            .unwrap_or("bad")
            .to_owned();
        if !["good", "bad", "neutral"].contains(&style.as_str()) {
            reader.fail(
                format!("{rule_path}.style"),
                "must be one of good, bad, neutral",
            );
            continue;
        }
        rules.push(Conditional {
            range,
            rule: fields
                .get("rule")
                .and_then(Json::as_str)
                .unwrap_or("cellIs")
                .to_owned(),
            operator,
            value: fields.get("value").and_then(Json::as_f64).unwrap_or(0.0),
            style,
        });
    }
    rules
}

fn read_charts(reader: &mut Reader, value: Option<&Json>, path: &str) -> Vec<Chart> {
    let Some(entries) = value.and_then(Json::as_array) else {
        if value.is_some() {
            reader.fail(format!("{path}.charts"), "must be an array");
        }
        return Vec::new();
    };
    let mut charts = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let chart_path = format!("{path}.charts[{index}]");
        let Some(fields) = entry.as_object() else {
            reader.fail(&chart_path, "must be an object");
            continue;
        };
        let kind = fields
            .get("type")
            .and_then(Json::as_str)
            .unwrap_or("column")
            .to_owned();
        if !["bar", "column", "line", "pie", "scatter"].contains(&kind.as_str()) {
            reader.fail(
                format!("{chart_path}.type"),
                "must be one of bar, column, line, pie, scatter",
            );
            continue;
        }
        let Some(categories) = reader.text(
            fields.get("categories"),
            &format!("{chart_path}.categories"),
            true,
        ) else {
            continue;
        };
        let Some(series_list) = fields.get("series").and_then(Json::as_array) else {
            reader.fail(
                format!("{chart_path}.series"),
                "must be an array of {name, values}",
            );
            continue;
        };
        let mut series = Vec::new();
        for (series_index, entry) in series_list.iter().enumerate() {
            let series_path = format!("{chart_path}.series[{series_index}]");
            let Some(fields) = entry.as_object() else {
                reader.fail(&series_path, "must be a {name, values} object");
                continue;
            };
            let name = reader
                .text(fields.get("name"), &format!("{series_path}.name"), true)
                .unwrap_or_default();
            let Some(values) =
                reader.text(fields.get("values"), &format!("{series_path}.values"), true)
            else {
                continue;
            };
            series.push((name, values));
        }
        if series.is_empty() {
            reader.fail(
                format!("{chart_path}.series"),
                "must contain at least one series",
            );
            continue;
        }
        charts.push(Chart {
            kind,
            title: fields
                .get("title")
                .and_then(Json::as_str)
                .map(str::to_owned),
            categories,
            series,
            anchor: fields
                .get("anchor")
                .and_then(Json::as_str)
                .unwrap_or("E2")
                .to_owned(),
        });
    }
    charts
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_formula_outside_the_allowlist_fails_at_the_cell_that_holds_it() {
        let errors = read_workbook_spec(&json!({
            "sheets": [{
                "name": "Model",
                "rows": [[{"f": "=INDIRECT(\"A1\")"}]]
            }]
        }))
        .expect_err("should be refused");
        assert_eq!(errors[0].path, "sheets[0].rows[0][0].f");
        assert!(
            errors[0]
                .message
                .contains("INDIRECT is not on the allowed function list")
        );
    }

    #[test]
    fn an_allowlisted_formula_is_accepted_and_kept_without_its_equals_sign() {
        let spec = read_workbook_spec(&json!({
            "sheets": [{"name": "Model", "rows": [[{"f": "=SUM(A1:A3)"}]]}]
        }))
        .expect("valid");
        match &spec.sheets[0].rows[0][0].value {
            CellValue::Formula(body) => assert_eq!(body, "SUM(A1:A3)"),
            other => panic!("expected a formula, got {other:?}"),
        }
    }

    #[test]
    fn sheet_names_follow_excels_own_rules() {
        let errors = read_workbook_spec(&json!({
            "sheets": [{"name": "Bad/Name", "rows": []}]
        }))
        .expect_err("should be refused");
        assert_eq!(errors[0].path, "sheets[0].name");

        let duplicates = read_workbook_spec(&json!({
            "sheets": [{"name": "Data", "rows": []}, {"name": "Data", "rows": []}]
        }))
        .expect_err("should be refused");
        assert_eq!(duplicates[0].path, "sheets[1].name");
    }

    #[test]
    fn cell_shapes_cover_the_four_things_a_cell_can_be() {
        let spec = read_workbook_spec(&json!({
            "sheets": [{
                "name": "Data",
                "rows": [[1.5, "text", true, {"d": "2026-01-31"}, {"v": 0.05, "role": "input"}]]
            }]
        }))
        .expect("valid");
        let row = &spec.sheets[0].rows[0];
        assert!(matches!(row[0].value, CellValue::Number(_)));
        assert!(matches!(row[1].value, CellValue::Text(_)));
        assert!(matches!(row[2].value, CellValue::Bool(true)));
        assert!(matches!(row[3].value, CellValue::Date(_)));
        assert_eq!(row[4].role, Some(CellRole::Input));
    }

    #[test]
    fn an_unreadable_date_says_what_shape_it_wanted() {
        let errors = read_workbook_spec(&json!({
            "sheets": [{"name": "Data", "rows": [[{"d": "31 January"}]]}]
        }))
        .expect_err("should be refused");
        assert_eq!(errors[0].path, "sheets[0].rows[0][0].d");
        assert!(errors[0].message.contains("2026-01-31"));
    }

    #[test]
    fn iso_dates_convert_to_the_serials_excel_uses() {
        // The reference points every spreadsheet developer knows by heart.
        assert_eq!(parse_iso_date("1900-01-01"), Some(2.0));
        assert_eq!(parse_iso_date("2026-01-31"), Some(46_053.0));
        assert_eq!(parse_iso_date("not-a-date"), None);
    }
}
