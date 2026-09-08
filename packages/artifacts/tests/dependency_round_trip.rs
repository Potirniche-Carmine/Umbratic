use std::io::{Cursor, Read};

use rust_xlsxwriter::{DataValidation, DataValidationRule, Workbook};
use serde_json::json;
use umbratic_artifacts::edit::apply_ops;

fn sheet_xml(bytes: &[u8]) -> String {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    archive
        .by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    xml
}

#[test]
fn editing_a_cell_preserves_both_validation_bounds() {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name("Data").unwrap();
    sheet.write_number(0, 0, 5).unwrap();
    let validation = DataValidation::new().allow_whole_number(DataValidationRule::Between(1, 10));
    sheet.add_data_validation(0, 0, 9, 0, &validation).unwrap();
    let input = workbook.save_to_buffer().unwrap();
    let before = sheet_xml(&input);
    assert!(before.contains("<formula1>1</formula1>"));
    assert!(before.contains("<formula2>10</formula2>"));

    let edited = apply_ops(
        &input,
        &[json!({"op": "setCells", "sheet": "Data", "cells": {"B1": "edited"}})],
        "surgical",
    )
    .unwrap();
    let after = sheet_xml(&edited.bytes);
    assert!(after.contains("<formula1>1</formula1>"), "{after}");
    assert!(after.contains("<formula2>10</formula2>"), "{after}");
    let reread =
        umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(edited.bytes), true).unwrap();
    assert_eq!(
        reread
            .sheet_by_name("Data")
            .unwrap()
            .cell("B1")
            .unwrap()
            .value(),
        "edited"
    );
}

#[test]
fn invalid_defined_names_return_errors_without_panicking() {
    for name in ["", "Sheet1!", "!Name", "Sheet1!Name!Extra"] {
        let mut workbook = Workbook::new();
        workbook.add_worksheet();
        assert!(workbook.define_name(name, "=Sheet1!$A$1").is_err());
    }
}
