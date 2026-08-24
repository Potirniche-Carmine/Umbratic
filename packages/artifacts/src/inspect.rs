//! Reading a workbook.
//!
//! What a model needs to plan an edit is not the data — it is the shape: which
//! sheets exist, what the header row says, roughly what the first rows look
//! like, where the formulas are, and which features are present that we will
//! not touch. So the outline is bounded on purpose. Twenty sample rows and a
//! sampled formula map describe a hundred-thousand-row sheet well enough to
//! address it, and a full dump would not fit in the result anyway.

use std::collections::BTreeMap;

use calamine::{Data, Reader, Xlsx, XlsxError};
use serde::Serialize;

use crate::formula::{address_of, column_letters};

/// Rows of real data shown per sheet.
const SAMPLE_ROWS: usize = 20;
/// Formula cells listed per sheet before the rest become a count.
const SAMPLE_FORMULAS: usize = 40;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unsupported {
    pub kind: String,
    #[serde(rename = "where")]
    pub location: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetSummary {
    pub name: String,
    pub rows: usize,
    pub columns: usize,
    /// The first row, when it reads like a header.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub header: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sample: Vec<Vec<String>>,
    /// Address to formula, sampled.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub formulas: BTreeMap<String, String>,
    pub formula_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freeze: Option<String>,
    pub hidden: bool,
    /// Cells already holding an Excel error value.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookOutline {
    pub sheet_count: usize,
    pub sheets: Vec<SheetSummary>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub defined_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub origin: String,
    pub edit_surface: String,
    pub unsupported: Vec<Unsupported>,
    pub outline: WorkbookOutline,
}

/// The custom property a workbook we wrote carries.
pub const ORIGIN_PROPERTY: &str = "UmbraticArtifact";

pub fn inspect_workbook(bytes: &[u8]) -> Result<Inspection, String> {
    let unsupported = scan_package(bytes)?;
    let origin = if has_origin_stamp(bytes) {
        "umbratic"
    } else {
        "foreign"
    };

    // An encrypted or legacy file has nothing a reader can open. Answering here
    // keeps the failure named — "encrypted" rather than "could not find EOCD",
    // which is true but tells nobody what to do about it.
    if unsupported.iter().any(|entry| entry.kind == "encrypted") {
        return Ok(Inspection {
            origin: origin.into(),
            edit_surface: "inspect-only".into(),
            unsupported,
            outline: WorkbookOutline {
                sheet_count: 0,
                sheets: Vec::new(),
                defined_names: Vec::new(),
            },
        });
    }

    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut workbook: Xlsx<_> = match Xlsx::new(cursor) {
        Ok(workbook) => workbook,
        Err(XlsxError::Password) => {
            return Ok(Inspection {
                origin: origin.into(),
                edit_surface: "inspect-only".into(),
                unsupported: vec![Unsupported {
                    kind: "encrypted".into(),
                    location: "the workbook is password protected".into(),
                }],
                outline: WorkbookOutline {
                    sheet_count: 0,
                    sheets: Vec::new(),
                    defined_names: Vec::new(),
                },
            });
        }
        Err(error) => return Err(format!("the workbook could not be opened: {error}")),
    };
    // Formulas have to be asked for separately; without this the map is empty
    // and every calculated cell looks like a literal.
    let _ = workbook.load_tables();

    let sheet_names = workbook.sheet_names().to_vec();
    let mut sheets = Vec::new();
    for name in &sheet_names {
        sheets.push(summarize_sheet(&mut workbook, name));
    }

    let defined_names = workbook
        .defined_names()
        .iter()
        .map(|(name, _)| name.clone())
        .collect();

    // Encryption is the only thing that stops an edit outright. Everything else
    // — a pivot, a macro, a slicer — means we work around it rather than refuse.
    let encrypted = unsupported.iter().any(|entry| entry.kind == "encrypted");
    let edit_surface = if encrypted {
        "inspect-only"
    } else if origin == "umbratic" && unsupported.is_empty() {
        "full"
    } else {
        "surgical"
    };

    Ok(Inspection {
        origin: origin.into(),
        edit_surface: edit_surface.into(),
        unsupported,
        outline: WorkbookOutline {
            sheet_count: sheets.len(),
            sheets,
            defined_names,
        },
    })
}

fn summarize_sheet(workbook: &mut Xlsx<std::io::Cursor<Vec<u8>>>, name: &str) -> SheetSummary {
    let range = workbook.worksheet_range(name).ok();
    let formulas_range = workbook.worksheet_formula(name).ok();

    let (rows, columns) = range
        .as_ref()
        .map(|range| (range.height(), range.width()))
        .unwrap_or((0, 0));

    let mut header = Vec::new();
    let mut sample = Vec::new();
    let mut errors = Vec::new();
    if let Some(range) = &range {
        let mut iterator = range.rows();
        if let Some(first) = iterator.next() {
            // A first row of nothing but text is a header; a first row with
            // numbers in it is data, and calling it a header would mislabel
            // every column.
            let cells: Vec<String> = first.iter().map(render_cell).collect();
            if !cells.is_empty()
                && cells.iter().any(|cell| !cell.is_empty())
                && first
                    .iter()
                    .all(|cell| matches!(cell, Data::String(_) | Data::Empty))
            {
                header = cells;
            } else {
                sample.push(cells);
            }
        }
        for row in iterator.take(SAMPLE_ROWS.saturating_sub(sample.len())) {
            sample.push(row.iter().map(render_cell).collect());
        }
        // Every calamine range is addressed from the sheet's used-range origin
        // rather than from A1, so a sheet whose data starts at B4 would report
        // every address three rows and one column too low without this.
        let (row_origin, column_origin) = range.start().unwrap_or((0, 0));
        for (row_index, row) in range.rows().enumerate() {
            for (column_index, cell) in row.iter().enumerate() {
                if let Data::Error(error) = cell {
                    errors.push(format!(
                        "{}{} is {error:?}",
                        column_letters(column_index as u32 + column_origin),
                        row_index as u32 + row_origin + 1
                    ));
                }
            }
        }
    }

    let mut formulas = BTreeMap::new();
    let mut formula_count = 0usize;
    if let Some(range) = &formulas_range {
        let (row_origin, column_origin) = range.start().unwrap_or((0, 0));
        for (row_index, row) in range.rows().enumerate() {
            for (column_index, cell) in row.iter().enumerate() {
                if cell.is_empty() {
                    continue;
                }
                formula_count += 1;
                if formulas.len() < SAMPLE_FORMULAS {
                    formulas.insert(
                        address_of(&crate::formula::CellRef {
                            sheet: None,
                            row: row_index as u32 + row_origin,
                            column: column_index as u32 + column_origin,
                        }),
                        cell.clone(),
                    );
                }
            }
        }
    }

    SheetSummary {
        name: name.to_owned(),
        rows,
        columns,
        header,
        sample,
        formulas,
        formula_count,
        freeze: None,
        hidden: false,
        errors: errors.into_iter().take(25).collect(),
    }
}

fn render_cell(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(value) => value.chars().take(120).collect(),
        Data::Float(value) => {
            if value.fract() == 0.0 && value.abs() < 1e15 {
                format!("{}", *value as i64)
            } else {
                format!("{value}")
            }
        }
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => value.to_string(),
        Data::Error(error) => format!("{error:?}"),
        Data::DateTime(value) => format!("{}", value.as_f64()),
        Data::DateTimeIso(value) => value.clone(),
        Data::DurationIso(value) => value.clone(),
    }
}

/// Looks for the features that decide the edit surface, by part name.
///
/// This reads the zip directory rather than parsing every part: the presence of
/// `xl/pivotCache/` or `vbaProject.bin` is a fact about the package, and
/// deciding it from the file listing is both cheaper and harder to get wrong
/// than inferring it from parsed content.
fn scan_package(bytes: &[u8]) -> Result<Vec<Unsupported>, String> {
    use std::io::Read;
    let mut found = Vec::new();
    if bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) {
        found.push(Unsupported {
            kind: "encrypted".into(),
            location: "the file is an OLE compound document: encrypted, or a legacy .xls".into(),
        });
        return Ok(found);
    }
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("the file is not an xlsx package: {error}"))?;

    let mut names = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("the package could not be read: {error}"))?;
        names.push(entry.name().to_owned());
    }

    let mark = |kind: &str, location: String, found: &mut Vec<Unsupported>| {
        if !found.iter().any(|entry| entry.kind == kind) {
            found.push(Unsupported {
                kind: kind.into(),
                location,
            });
        }
    };

    for name in &names {
        if name.contains("vbaProject.bin") {
            mark(
                "vba",
                "the workbook carries a VBA project".into(),
                &mut found,
            );
        }
        if name.contains("pivotCache") || name.contains("pivotTable") {
            mark("pivot", "the workbook has a pivot table".into(), &mut found);
        }
        if name.contains("queryTable") || name.contains("connections.xml") {
            mark(
                "power-query",
                "the workbook has an external data connection".into(),
                &mut found,
            );
        }
        if name.contains("slicer") {
            mark("slicer", "the workbook has a slicer".into(), &mut found);
        }
        if name.contains("externalLink") {
            mark(
                "external-link",
                "the workbook links to another workbook".into(),
                &mut found,
            );
        }
    }

    // An encrypted OOXML package is a zip whose only real part is the
    // encryption info, which the reader would otherwise report as "no sheets".
    if names.iter().any(|name| name == "EncryptionInfo") {
        mark("encrypted", "the workbook is encrypted".into(), &mut found);
    }

    if let Ok(mut entry) = archive.by_name("xl/workbook.xml") {
        let mut xml = String::new();
        if entry.read_to_string(&mut xml).is_ok()
            && xml.contains("fileSharing")
            && xml.contains("hashValue")
        {
            mark(
                "encrypted",
                "the workbook is protected with a password".into(),
                &mut found,
            );
        }
    }

    Ok(found)
}

fn has_origin_stamp(bytes: &[u8]) -> bool {
    use std::io::Read;
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let Ok(mut archive) = zip::ZipArchive::new(cursor) else {
        return false;
    };
    let Ok(mut entry) = archive.by_name("docProps/custom.xml") else {
        return false;
    };
    let mut xml = String::new();
    if entry.read_to_string(&mut xml).is_err() {
        return false;
    }
    xml.contains(ORIGIN_PROPERTY)
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
    fn a_created_workbook_reads_back_with_its_header_sample_and_formulas() {
        let bytes = build(json!({
            "sheets": [{
                "name": "Model",
                "columns": [{"header": "Item"}, {"header": "Value"}],
                "rows": [
                    ["Growth", {"v": 0.05, "role": "input"}],
                    ["Churn", {"f": "=1-B2", "role": "calc"}]
                ]
            }]
        }));
        let inspection = inspect_workbook(&bytes).expect("inspects");
        assert_eq!(inspection.outline.sheet_count, 1);
        let sheet = &inspection.outline.sheets[0];
        assert_eq!(sheet.name, "Model");
        assert_eq!(sheet.header, vec!["Item", "Value"]);
        assert_eq!(sheet.rows, 3, "header plus two data rows");
        assert_eq!(sheet.formula_count, 1);
        assert_eq!(sheet.formulas.get("B3").map(String::as_str), Some("1-B2"));
        assert!(sheet.errors.is_empty());
    }

    #[test]
    fn a_workbook_we_wrote_is_reported_as_ours_and_a_stranger_s_is_not() {
        let ours = build(json!({"sheets": [{"name": "Data", "rows": [[1]]}]}));
        let inspection = inspect_workbook(&ours).expect("inspects");
        assert_eq!(inspection.origin, "umbratic");
        assert_eq!(inspection.edit_surface, "full");

        // A workbook with the stamp removed is exactly what a stranger's file
        // looks like, and it drops to the surgical op set.
        let stripped = strip_custom_properties(&ours);
        let foreign = inspect_workbook(&stripped).expect("inspects");
        assert_eq!(foreign.origin, "foreign");
        assert_eq!(foreign.edit_surface, "surgical");
    }

    /// Rewrites the package without its custom properties part.
    fn strip_custom_properties(bytes: &[u8]) -> Vec<u8> {
        use std::io::{Read, Write};
        let cursor = std::io::Cursor::new(bytes.to_vec());
        let mut archive = zip::ZipArchive::new(cursor).expect("package");
        let mut output = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut output));
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).expect("entry");
                let name = entry.name().to_owned();
                if name == "docProps/custom.xml" {
                    continue;
                }
                let mut content = Vec::new();
                entry.read_to_end(&mut content).expect("read");
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .expect("start");
                writer.write_all(&content).expect("write");
            }
            writer.finish().expect("finish");
        }
        output
    }

    #[test]
    fn a_file_that_is_not_a_package_is_named_rather_than_reported_as_empty() {
        let mut ole = vec![0u8; 64];
        ole[..8].copy_from_slice(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        let inspection = inspect_workbook(&ole).expect("inspects");
        assert_eq!(inspection.edit_surface, "inspect-only");
        assert_eq!(inspection.unsupported[0].kind, "encrypted");
    }
}
