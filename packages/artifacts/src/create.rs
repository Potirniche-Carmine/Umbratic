//! Writing a workbook.
//!
//! `rust_xlsxwriter` produces the file; what lives here is the mapping from the
//! spec's vocabulary to it, and the one design decision that matters: colour
//! comes from `role`, not from the model. An input cell, a derived cell, and a
//! quoted output look different in every finance model anyone has ever opened,
//! and a model asked to pick colours picks them inconsistently between sheets.

use rust_xlsxwriter::{
    Chart, ChartType, Color, ConditionalFormatCell, ConditionalFormatCellRule, DataValidation,
    DataValidationRule, DocProperties, Format, FormatBorder, Workbook, Worksheet,
};

use crate::spec::{
    Cell, CellRole, CellValue, Chart as ChartSpec, SheetSpec, WorkbookSpec, parse_iso_date,
};

pub struct CreateOutcome {
    pub bytes: Vec<u8>,
    /// Cells that hold a formula, for the recalculation pass.
    pub formula_count: usize,
    pub sheet_dimensions: Vec<(String, usize, usize)>,
}

/// The finance colour convention, in one place.
fn role_format(role: CellRole, number_format: Option<&str>) -> Format {
    let base = Format::new();
    let format = match role {
        // Blue on a pale fill: what a person is meant to type over.
        CellRole::Input => base
            .set_font_color(Color::RGB(0x00_33_99))
            .set_background_color(Color::RGB(0xF2_F6_FC)),
        // Black: derived, do not touch.
        CellRole::Calc => base.set_font_color(Color::RGB(0x1F_29_33)),
        // Green: the number that gets quoted elsewhere.
        CellRole::Output => base.set_font_color(Color::RGB(0x1E_6B_3A)).set_bold(),
        CellRole::Total => base
            .set_bold()
            .set_border_top(FormatBorder::Thin)
            .set_border_bottom(FormatBorder::Double),
        CellRole::Header => base
            .set_bold()
            .set_font_color(Color::RGB(0x10_16_1D))
            .set_background_color(Color::RGB(0xF2_F5_F8))
            .set_border_bottom(FormatBorder::Thin),
    };
    match number_format {
        Some(pattern) => format.set_num_format(pattern),
        None => format,
    }
}

fn header_format() -> Format {
    role_format(CellRole::Header, None)
}

fn date_format(pattern: Option<&str>) -> Format {
    Format::new().set_num_format(pattern.unwrap_or("yyyy-mm-dd"))
}

/// The custom document property that says we wrote this file.
pub const ORIGIN_PROPERTY: &str = "UmbraticArtifact";

pub fn create_workbook(spec: &WorkbookSpec) -> Result<CreateOutcome, String> {
    let mut workbook = Workbook::new();
    // The origin stamp. Its presence is what lets inspect offer the full op set
    // instead of treating every workbook as a stranger's.
    workbook.set_properties(
        &DocProperties::new()
            .set_custom_property(ORIGIN_PROPERTY, "1")
            .set_author("Umbratic"),
    );
    let mut formula_count = 0usize;
    let mut sheet_dimensions = Vec::new();

    for sheet_spec in &spec.sheets {
        let worksheet = workbook.add_worksheet();
        worksheet
            .set_name(&sheet_spec.name)
            .map_err(|error| format!("sheet {}: {error}", sheet_spec.name))?;
        let written = write_sheet(worksheet, sheet_spec)?;
        formula_count += written;
        let columns = sheet_spec
            .rows
            .iter()
            .map(Vec::len)
            .max()
            .unwrap_or(sheet_spec.columns.len());
        let header_rows = usize::from(!sheet_spec.columns.is_empty());
        sheet_dimensions.push((
            sheet_spec.name.clone(),
            sheet_spec.rows.len() + header_rows,
            columns,
        ));
    }

    // Named ranges belong to the workbook rather than to a sheet, so they are
    // defined after every sheet exists — a name that pointed at a sheet not yet
    // added would resolve to nothing.
    for sheet_spec in &spec.sheets {
        for (name, target) in &sheet_spec.named_ranges {
            let qualified = if target.contains('!') {
                format!("={target}")
            } else {
                format!("='{}'!{}", sheet_spec.name, absolute_reference(target))
            };
            workbook
                .define_name(name, &qualified)
                .map_err(|error| format!("named range {name}: {error}"))?;
        }
    }

    let bytes = workbook
        .save_to_buffer()
        .map_err(|error| format!("the workbook could not be written: {error}"))?;
    Ok(CreateOutcome {
        bytes,
        formula_count,
        sheet_dimensions,
    })
}

fn write_sheet(worksheet: &mut Worksheet, spec: &SheetSpec) -> Result<usize, String> {
    let mut row_offset = 0u32;

    if !spec.columns.is_empty() {
        let format = header_format();
        for (index, column) in spec.columns.iter().enumerate() {
            worksheet
                .write_string_with_format(0, index as u16, &column.header, &format)
                .map_err(stringify)?;
            if let Some(width) = column.width {
                worksheet
                    .set_column_width(index as u16, width)
                    .map_err(stringify)?;
            }
        }
        row_offset = 1;
    }

    let mut formula_count = 0usize;
    for (row_index, row) in spec.rows.iter().enumerate() {
        let row_number = row_index as u32 + row_offset;
        for (column_index, cell) in row.iter().enumerate() {
            let column_number = column_index as u16;
            // A cell's own format wins; otherwise the column's applies, which is
            // how "this column is a percentage" is said once rather than per row.
            let pattern = cell.format.as_deref().or_else(|| {
                spec.columns
                    .get(column_index)
                    .and_then(|column| column.format.as_deref())
            });
            if write_cell(worksheet, row_number, column_number, cell, pattern)? {
                formula_count += 1;
            }
        }
    }

    if let Some(freeze) = &spec.freeze
        && let Some(reference) = crate::formula::parse_reference(freeze)
    {
        worksheet
            .set_freeze_panes(reference.row, reference.column as u16)
            .map_err(stringify)?;
    }

    for rule in &spec.validation {
        if let Some(validation) = build_validation(rule)
            && let Some((first, last)) = parse_range(&rule.range)
        {
            worksheet
                .add_data_validation(first.0, first.1, last.0, last.1, &validation)
                .map_err(stringify)?;
        }
    }

    for rule in &spec.conditional {
        if let Some((first, last)) = parse_range(&rule.range) {
            let format = match rule.style.as_str() {
                "good" => Format::new()
                    .set_font_color(Color::RGB(0x00_61_00))
                    .set_background_color(Color::RGB(0xC6_EF_CE)),
                "neutral" => Format::new()
                    .set_font_color(Color::RGB(0x9C_65_00))
                    .set_background_color(Color::RGB(0xFF_EB_9C)),
                _ => Format::new()
                    .set_font_color(Color::RGB(0x9C_00_06))
                    .set_background_color(Color::RGB(0xFF_C7_CE)),
            };
            let condition = match rule.operator.as_str() {
                "lessThan" => ConditionalFormatCellRule::LessThan(rule.value),
                "equal" => ConditionalFormatCellRule::EqualTo(rule.value),
                "notEqual" => ConditionalFormatCellRule::NotEqualTo(rule.value),
                _ => ConditionalFormatCellRule::GreaterThan(rule.value),
            };
            let conditional = ConditionalFormatCell::new()
                .set_rule(condition)
                .set_format(format);
            worksheet
                .add_conditional_format(first.0, first.1, last.0, last.1, &conditional)
                .map_err(stringify)?;
        }
    }

    for chart in &spec.charts {
        add_chart(worksheet, chart, &spec.name)?;
    }

    Ok(formula_count)
}

/// Writes one cell. Returns whether it held a formula.
fn write_cell(
    worksheet: &mut Worksheet,
    row: u32,
    column: u16,
    cell: &Cell,
    pattern: Option<&str>,
) -> Result<bool, String> {
    let format = cell.role.map(|role| role_format(role, pattern));
    match &cell.value {
        CellValue::Empty => {
            if let Some(format) = format {
                worksheet
                    .write_blank(row, column, &format)
                    .map_err(stringify)?;
            }
            Ok(false)
        }
        CellValue::Number(value) => {
            match (format, pattern) {
                (Some(format), _) => {
                    worksheet.write_number_with_format(row, column, *value, &format)
                }
                (None, Some(pattern)) => worksheet.write_number_with_format(
                    row,
                    column,
                    *value,
                    &Format::new().set_num_format(pattern),
                ),
                (None, None) => worksheet.write_number(row, column, *value),
            }
            .map_err(stringify)?;
            Ok(false)
        }
        CellValue::Text(value) => {
            match format {
                Some(format) => worksheet.write_string_with_format(row, column, value, &format),
                None => worksheet.write_string(row, column, value),
            }
            .map_err(stringify)?;
            Ok(false)
        }
        CellValue::Bool(value) => {
            worksheet
                .write_boolean(row, column, *value)
                .map_err(stringify)?;
            Ok(false)
        }
        CellValue::Date(value) => {
            // Written as a serial with a date format rather than as text, so
            // the cell sorts, filters, and takes date arithmetic.
            let serial = parse_iso_date(value).unwrap_or(0.0);
            worksheet
                .write_number_with_format(row, column, serial, &date_format(pattern))
                .map_err(stringify)?;
            Ok(false)
        }
        CellValue::Formula(body) => {
            let formula = format!("={body}");
            match (format, pattern) {
                (Some(format), _) => {
                    worksheet.write_formula_with_format(row, column, formula.as_str(), &format)
                }
                (None, Some(pattern)) => worksheet.write_formula_with_format(
                    row,
                    column,
                    formula.as_str(),
                    &Format::new().set_num_format(pattern),
                ),
                (None, None) => worksheet.write_formula(row, column, formula.as_str()),
            }
            .map_err(stringify)?;
            Ok(true)
        }
    }
}

fn build_validation(rule: &crate::spec::Validation) -> Option<DataValidation> {
    let validation = DataValidation::new();
    match rule.kind.as_str() {
        "list" => {
            if rule.list.is_empty() {
                return None;
            }
            Some(validation.allow_list_strings(&rule.list).ok()?)
        }
        "whole" => Some(validation.allow_whole_number(numeric_rule(
            rule.min.map(|value| value as i32),
            rule.max.map(|value| value as i32),
        )?)),
        "textLength" => Some(validation.allow_text_length(numeric_rule(
            rule.min.map(|value| value as u32),
            rule.max.map(|value| value as u32),
        )?)),
        _ => Some(validation.allow_decimal_number(numeric_rule(rule.min, rule.max)?)),
    }
}

/// The four shapes a min/max pair can take. Generic over the numeric type the
/// writer wants for each validation kind, which differs by kind.
fn numeric_rule<T>(min: Option<T>, max: Option<T>) -> Option<DataValidationRule<T>>
where
    T: Copy + rust_xlsxwriter::IntoDataValidationValue,
{
    match (min, max) {
        (Some(min), Some(max)) => Some(DataValidationRule::Between(min, max)),
        (Some(min), None) => Some(DataValidationRule::GreaterThanOrEqualTo(min)),
        (None, Some(max)) => Some(DataValidationRule::LessThanOrEqualTo(max)),
        (None, None) => None,
    }
}

fn add_chart(worksheet: &mut Worksheet, spec: &ChartSpec, sheet_name: &str) -> Result<(), String> {
    let kind = match spec.kind.as_str() {
        "bar" => ChartType::Bar,
        "line" => ChartType::Line,
        "pie" => ChartType::Pie,
        "scatter" => ChartType::Scatter,
        _ => ChartType::Column,
    };
    let mut chart = Chart::new(kind);
    if let Some(title) = &spec.title {
        chart.title().set_name(title);
    }
    for (name, values) in &spec.series {
        let series = chart.add_series();
        series.set_name(name.as_str());
        series.set_values(qualify(values, sheet_name).as_str());
        series.set_categories(qualify(&spec.categories, sheet_name).as_str());
    }
    // One series needs no legend and the space reads better without it.
    if spec.series.len() < 2 && spec.kind != "pie" {
        chart.legend().set_hidden();
    }
    let anchor = crate::formula::parse_reference(&spec.anchor)
        .ok_or_else(|| format!("chart anchor {} is not a cell", spec.anchor))?;
    worksheet
        .insert_chart(anchor.row, anchor.column as u16, &chart)
        .map_err(stringify)?;
    Ok(())
}

/// A chart range must name its sheet, or Excel resolves it against whichever
/// sheet happens to be active when the file opens.
fn qualify(range: &str, sheet_name: &str) -> String {
    if range.contains('!') {
        return range.to_owned();
    }
    format!("'{sheet_name}'!{range}")
}

fn parse_range(range: &str) -> Option<((u32, u16), (u32, u16))> {
    let cleaned = range.rsplit('!').next()?;
    let (start, end) = match cleaned.split_once(':') {
        Some((start, end)) => (start, end),
        None => (cleaned, cleaned),
    };
    let first = crate::formula::parse_reference(start)?;
    let last = crate::formula::parse_reference(end)?;
    Some((
        (first.row, first.column as u16),
        (last.row, last.column as u16),
    ))
}

/// A defined name has to be absolute, or it shifts when a row is inserted
/// above it — which is the one thing a named range exists to prevent.
fn absolute_reference(target: &str) -> String {
    target
        .split(':')
        .map(|part| {
            let cleaned = part.replace('$', "").to_uppercase();
            match crate::formula::parse_reference(&cleaned) {
                Some(reference) => format!(
                    "${}${}",
                    crate::formula::column_letters(reference.column),
                    reference.row + 1
                ),
                None => cleaned,
            }
        })
        .collect::<Vec<_>>()
        .join(":")
}

fn stringify(error: rust_xlsxwriter::XlsxError) -> String {
    error.to_string()
}
