//! Editing an existing workbook.
//!
//! `umya-spreadsheet` is used rather than a read-then-rewrite because a
//! workbook is mostly things this tool does not model: charts, conditional
//! formats, data validation, column widths, print areas, the styles someone
//! spent an afternoon on. Reading the cells and writing a new file would lose
//! all of it. umya round-trips the parts it does not understand, so an edit
//! changes what it was asked to change.
//!
//! Formulas already in the file are never rewritten. A new formula an op
//! introduces has to be on the allowlist, for the same reason it does at create
//! time: a formula we cannot evaluate is a formula we cannot check.

use umya_spreadsheet::{Workbook, Worksheet};

use crate::formula::{self, ParseError, address_of, column_letters, parse_reference};

#[derive(Debug, Clone, serde::Serialize)]
pub struct OpError {
    pub path: String,
    pub message: String,
}

pub struct EditOutcome {
    pub bytes: Vec<u8>,
    pub applied: Vec<String>,
}

const SURGICAL_OPS: &[&str] = &[
    "setCells",
    "appendRows",
    "insertRows",
    "insertColumns",
    "deleteRows",
    "deleteColumns",
    "findReplace",
    "addSheet",
    "renameSheet",
    "setFormat",
    "setFreeze",
];

const FULL_ONLY_OPS: &[&str] = &[
    "setValidation",
    "setConditional",
    "addChart",
    "setNamedRange",
    "deleteSheet",
];

pub fn apply_ops(
    bytes: &[u8],
    ops: &[serde_json::Value],
    edit_surface: &str,
) -> Result<EditOutcome, Vec<OpError>> {
    if edit_surface == "inspect-only" {
        return Err(vec![OpError {
            path: "ops[0]".into(),
            message: "editSurface is inspect-only".into(),
        }]);
    }
    // Read and written entirely in memory. The temp-file route this used to
    // take needed a unique name per call to be safe under concurrency, and the
    // reader takes a cursor, so there was never a reason to touch the disk.
    let mut book = umya_spreadsheet::reader::xlsx::read_reader(std::io::Cursor::new(bytes), true)
        .map_err(|error| {
        vec![OpError {
            path: "path".into(),
            message: format!("the workbook could not be opened: {error}"),
        }]
    })?;

    let mut applied = Vec::new();
    for (index, op) in ops.iter().enumerate() {
        let path = format!("ops[{index}]");
        let Some(fields) = op.as_object() else {
            return Err(vec![OpError {
                path,
                message: "must be an object with an op field".into(),
            }]);
        };
        let kind = fields
            .get("op")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if !SURGICAL_OPS.contains(&kind) && !FULL_ONLY_OPS.contains(&kind) {
            let mut allowed: Vec<&str> =
                SURGICAL_OPS.iter().chain(FULL_ONLY_OPS).copied().collect();
            allowed.sort_unstable();
            return Err(vec![OpError {
                path: format!("{path}.op"),
                message: format!(
                    "{} is not an operation; use one of {}",
                    if kind.is_empty() { "(missing)" } else { kind },
                    allowed.join(", ")
                ),
            }]);
        }
        if FULL_ONLY_OPS.contains(&kind) && edit_surface != "full" {
            return Err(vec![OpError {
                path: format!("{path}.op"),
                message: format!("{kind} needs a full edit surface; this workbook is surgical"),
            }]);
        }
        match apply_one(&mut book, kind, op, &path) {
            Ok(summary) => applied.push(summary),
            Err(error) => return Err(vec![error]),
        }
    }

    let mut output = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&book, &mut output).map_err(|error| {
        vec![OpError {
            path: String::new(),
            message: format!("the workbook could not be written: {error}"),
        }]
    })?;
    Ok(EditOutcome {
        bytes: output,
        applied,
    })
}

fn apply_one(
    book: &mut Workbook,
    kind: &str,
    op: &serde_json::Value,
    path: &str,
) -> Result<String, OpError> {
    match kind {
        "setCells" => set_cells(book, op, path),
        "appendRows" => append_rows(book, op, path),
        "insertRows" => shift(book, op, path, Shift::InsertRows),
        "insertColumns" => shift(book, op, path, Shift::InsertColumns),
        "deleteRows" => shift(book, op, path, Shift::DeleteRows),
        "deleteColumns" => shift(book, op, path, Shift::DeleteColumns),
        "findReplace" => find_replace(book, op, path),
        "addSheet" => add_sheet(book, op, path),
        "renameSheet" => rename_sheet(book, op, path),
        "deleteSheet" => delete_sheet(book, op, path),
        "setFreeze" => set_freeze(book, op, path),
        "setFormat" => set_format(book, op, path),
        "setNamedRange" => set_named_range(book, op, path),
        // The remaining full-surface ops are declared but write nothing this
        // engine can round-trip safely yet; refusing by name beats writing a
        // rule umya would drop on the next save.
        other => Err(OpError {
            path: format!("{path}.op"),
            message: format!("{other} is not implemented in this build"),
        }),
    }
}

fn fail(path: &str, message: impl Into<String>) -> OpError {
    OpError {
        path: path.into(),
        message: message.into(),
    }
}

fn sheet_of<'a>(
    book: &'a mut Workbook,
    op: &serde_json::Value,
    path: &str,
) -> Result<&'a mut Worksheet, OpError> {
    let name = op
        .get("sheet")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.sheet"), "must name a sheet from inspect"))?
        .to_owned();
    let available: Vec<String> = book
        .sheet_collection()
        .iter()
        .map(|sheet| sheet.name().to_owned())
        .collect();
    book.sheet_by_name_mut(&name).map_err(|_| {
        fail(
            &format!("{path}.sheet"),
            format!(
                "no sheet named \"{name}\"; the workbook has {}",
                available.join(", ")
            ),
        )
    })
}

/// Turns a JSON cell into what umya writes, refusing formulas off the allowlist.
fn write_value(
    sheet: &mut Worksheet,
    address: &str,
    value: &serde_json::Value,
    path: &str,
) -> Result<(), OpError> {
    let cell = sheet.cell_mut(address);
    match value {
        serde_json::Value::Null => {
            cell.set_value("");
        }
        serde_json::Value::Bool(flag) => {
            cell.set_value_bool(*flag);
        }
        serde_json::Value::Number(number) => {
            cell.set_value_number(number.as_f64().unwrap_or(0.0));
        }
        serde_json::Value::String(text) => {
            if let Some(body) = text.strip_prefix('=') {
                match formula::parse(body) {
                    Ok(_) => {
                        cell.set_formula(body);
                    }
                    Err(ParseError::NotAllowed(name)) => {
                        return Err(fail(
                            path,
                            format!(
                                "{name} is not on the allowed function list; use one of {}",
                                formula::ALLOWED_FUNCTIONS.join(" ")
                            ),
                        ));
                    }
                    Err(ParseError::Syntax(detail)) => {
                        return Err(fail(
                            path,
                            format!("the formula could not be read: {detail}"),
                        ));
                    }
                }
            } else {
                cell.set_value_string(text.clone());
            }
        }
        other => {
            return Err(fail(
                path,
                format!("{other} is not a cell value; send a number, string, boolean, or null"),
            ));
        }
    }
    Ok(())
}

fn set_cells(book: &mut Workbook, op: &serde_json::Value, path: &str) -> Result<String, OpError> {
    let cells = op
        .get("cells")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            fail(
                &format!("{path}.cells"),
                "must be an object of addresses to values",
            )
        })?
        .clone();
    let sheet = sheet_of(book, op, path)?;
    for (address, value) in &cells {
        if parse_reference(address).is_none() {
            return Err(fail(
                &format!("{path}.cells.{address}"),
                "is not a cell address such as B2",
            ));
        }
        write_value(sheet, address, value, &format!("{path}.cells.{address}"))?;
    }
    Ok(format!("setCells {} cell(s)", cells.len()))
}

fn append_rows(book: &mut Workbook, op: &serde_json::Value, path: &str) -> Result<String, OpError> {
    let rows = op
        .get("rows")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| fail(&format!("{path}.rows"), "must be an array of row arrays"))?
        .clone();
    let sheet = sheet_of(book, op, path)?;
    // The first free row, so an append never lands on top of existing data.
    let start = sheet.highest_row() + 1;
    for (row_index, row) in rows.iter().enumerate() {
        let cells = row.as_array().ok_or_else(|| {
            fail(
                &format!("{path}.rows[{row_index}]"),
                "must be an array of cell values",
            )
        })?;
        for (column_index, value) in cells.iter().enumerate() {
            let address = format!(
                "{}{}",
                column_letters(column_index as u32),
                start + row_index as u32
            );
            write_value(
                sheet,
                &address,
                value,
                &format!("{path}.rows[{row_index}][{column_index}]"),
            )?;
        }
    }
    Ok(format!("appendRows {}", rows.len()))
}

enum Shift {
    InsertRows,
    InsertColumns,
    DeleteRows,
    DeleteColumns,
}

/// Row and column insertion, which shifts every reference that pointed past it.
///
/// umya rewrites the formulas for us, which is the whole reason this op is
/// worth having: doing it by hand means re-parsing every formula in the
/// workbook and getting the absolute-versus-relative rules right.
fn shift(
    book: &mut Workbook,
    op: &serde_json::Value,
    path: &str,
    kind: Shift,
) -> Result<String, OpError> {
    let at = op
        .get("at")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            fail(
                &format!("{path}.at"),
                "must be a row or column number, starting at 1",
            )
        })? as u32;
    if at == 0 {
        return Err(fail(&format!("{path}.at"), "starts at 1"));
    }
    let count = op
        .get("count")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1) as u32;
    if count == 0 {
        return Err(fail(&format!("{path}.count"), "must be at least 1"));
    }
    let name = op
        .get("sheet")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.sheet"), "must name a sheet from inspect"))?
        .to_owned();
    if book.sheet_by_name(&name).is_err() {
        return Err(fail(
            &format!("{path}.sheet"),
            format!("no sheet named \"{name}\""),
        ));
    }
    match kind {
        Shift::InsertRows => {
            book.insert_new_row(&name, at, count);
            Ok(format!("insertRows {count} at {at}"))
        }
        Shift::InsertColumns => {
            book.insert_new_column_by_index(&name, at, count);
            Ok(format!("insertColumns {count} at {at}"))
        }
        Shift::DeleteRows => {
            book.remove_row(&name, at, count);
            Ok(format!("deleteRows {count} at {at}"))
        }
        Shift::DeleteColumns => {
            book.remove_column_by_index(&name, at, count);
            Ok(format!("deleteColumns {count} at {at}"))
        }
    }
}

fn find_replace(
    book: &mut Workbook,
    op: &serde_json::Value,
    path: &str,
) -> Result<String, OpError> {
    let find = op
        .get("find")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| fail(&format!("{path}.find"), "must be the text to look for"))?
        .to_owned();
    let replace = op
        .get("replace")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.replace"), "must be a string"))?
        .to_owned();
    let scope = op
        .get("sheet")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);

    let mut replaced = 0usize;
    let names: Vec<String> = book
        .sheet_collection()
        .iter()
        .map(|sheet| sheet.name().to_owned())
        .filter(|name| scope.as_ref().is_none_or(|wanted| wanted == name))
        .collect();
    if names.is_empty() {
        return Err(fail(
            &format!("{path}.sheet"),
            "names no sheet in this workbook",
        ));
    }
    for name in names {
        let Ok(sheet) = book.sheet_by_name_mut(&name) else {
            continue;
        };
        let addresses: Vec<String> = sheet
            .collection_to_hashmap()
            .values()
            .filter(|cell| {
                // A formula is left alone: replacing text inside one silently
                // rewrites a calculation the user did not ask to change.
                cell.formula().is_empty() && cell.value().contains(&find)
            })
            .map(|cell| cell.coordinate().get_coordinate())
            .collect();
        for address in addresses {
            let cell = sheet.cell_mut(address.as_str());
            let updated = cell.value().replace(&find, &replace);
            cell.set_value_string(updated);
            replaced += 1;
        }
    }
    if replaced == 0 {
        return Err(fail(
            path,
            format!("\"{find}\" does not appear in any value cell, so nothing was changed"),
        ));
    }
    Ok(format!("findReplace {replaced} cell(s)"))
}

fn add_sheet(book: &mut Workbook, op: &serde_json::Value, path: &str) -> Result<String, OpError> {
    let name = op
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.name"), "must be the new sheet's name"))?;
    if name.chars().count() > 31 || name.contains([':', '\\', '/', '?', '*', '[', ']']) {
        return Err(fail(
            &format!("{path}.name"),
            r#"must be at most 31 characters and cannot contain : \ / ? * [ or ]"#,
        ));
    }
    book.new_sheet(name)
        .map_err(|error| fail(&format!("{path}.name"), format!("{error}")))?;
    Ok(format!("addSheet {name}"))
}

fn rename_sheet(
    book: &mut Workbook,
    op: &serde_json::Value,
    path: &str,
) -> Result<String, OpError> {
    let to = op
        .get("to")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.to"), "must be the new name"))?
        .to_owned();
    let sheet = sheet_of(book, op, path)?;
    let from = sheet.name().to_owned();
    sheet.set_name(&to);
    Ok(format!("renameSheet {from} to {to}"))
}

fn delete_sheet(
    book: &mut Workbook,
    op: &serde_json::Value,
    path: &str,
) -> Result<String, OpError> {
    let name = op
        .get("sheet")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.sheet"), "must name a sheet from inspect"))?
        .to_owned();
    if book.sheet_collection().len() <= 1 {
        return Err(fail(path, "a workbook must keep at least one sheet"));
    }
    let index = book
        .sheet_collection()
        .iter()
        .position(|sheet| sheet.name() == name)
        .ok_or_else(|| {
            fail(
                &format!("{path}.sheet"),
                format!("no sheet named \"{name}\""),
            )
        })?;
    book.remove_sheet(index)
        .map_err(|error| fail(path, format!("{error}")))?;
    Ok(format!("deleteSheet {name}"))
}

fn set_freeze(book: &mut Workbook, op: &serde_json::Value, path: &str) -> Result<String, OpError> {
    let at = op
        .get("at")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.at"), "must be a cell such as A2"))?
        .to_owned();
    let reference = parse_reference(&at)
        .ok_or_else(|| fail(&format!("{path}.at"), "must be a cell such as A2"))?;
    let sheet = sheet_of(book, op, path)?;
    // A frozen pane is a split at the cell's own row and column with the
    // panes below and right left scrollable — which is what "freeze the header
    // row" means, as opposed to a split the user can drag.
    let mut pane = umya_spreadsheet::Pane::default();
    pane.set_top_left_cell(
        umya_spreadsheet::Coordinate::default()
            .set_col_num(reference.column + 1)
            .set_row_num(reference.row + 1)
            .clone(),
    );
    pane.set_horizontal_split(f64::from(reference.column));
    pane.set_vertical_split(f64::from(reference.row));
    pane.set_state(umya_spreadsheet::PaneStateValues::Frozen);
    pane.set_active_pane(umya_spreadsheet::PaneValues::BottomRight);
    let views = sheet.sheet_views_mut().sheet_view_list_mut();
    if views.is_empty() {
        views.push(umya_spreadsheet::SheetView::default());
    }
    views[0].set_pane(pane);
    Ok(format!("setFreeze {at}"))
}

fn set_format(book: &mut Workbook, op: &serde_json::Value, path: &str) -> Result<String, OpError> {
    let range = op
        .get("range")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            fail(
                &format!("{path}.range"),
                "must be a cell or range such as B2:B10",
            )
        })?
        .to_owned();
    let pattern = op
        .get("format")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            fail(
                &format!("{path}.format"),
                "must be a number format such as 0.0%",
            )
        })?
        .to_owned();
    let sheet = sheet_of(book, op, path)?;
    let (first, last) = split_range(&range)
        .ok_or_else(|| fail(&format!("{path}.range"), "is not a cell or range"))?;
    let mut count = 0usize;
    for row in first.row..=last.row {
        for column in first.column..=last.column {
            let address = address_of(&formula::CellRef {
                sheet: None,
                row,
                column,
            });
            sheet
                .style_mut(address.as_str())
                .number_format_mut()
                .set_format_code(&pattern);
            count += 1;
        }
    }
    Ok(format!("setFormat {count} cell(s)"))
}

fn set_named_range(
    book: &mut Workbook,
    op: &serde_json::Value,
    path: &str,
) -> Result<String, OpError> {
    let name = op
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.name"), "must be the range's name"))?
        .to_owned();
    let range = op
        .get("range")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.range"), "must be a cell or range"))?
        .to_owned();
    let sheet_name = op
        .get("sheet")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| fail(&format!("{path}.sheet"), "must name a sheet from inspect"))?
        .to_owned();
    if book.sheet_by_name(&sheet_name).is_err() {
        return Err(fail(
            &format!("{path}.sheet"),
            format!("no sheet named \"{sheet_name}\""),
        ));
    }
    let mut defined = umya_spreadsheet::DefinedName::default();
    defined.set_name(name.clone());
    defined.set_address(format!("{sheet_name}!{range}"));
    book.add_defined_names(defined);
    Ok(format!("setNamedRange {name}"))
}

fn split_range(range: &str) -> Option<(formula::CellRef, formula::CellRef)> {
    let cleaned = range.rsplit('!').next()?;
    let (start, end) = match cleaned.split_once(':') {
        Some((start, end)) => (start, end),
        None => (cleaned, cleaned),
    };
    let first = parse_reference(start)?;
    let last = parse_reference(end)?;
    Some((
        formula::CellRef {
            sheet: None,
            row: first.row.min(last.row),
            column: first.column.min(last.column),
        },
        formula::CellRef {
            sheet: None,
            row: first.row.max(last.row),
            column: first.column.max(last.column),
        },
    ))
}
