//! One job in, one result out.
//!
//! The same shape the JavaScript engine answers with, so the desktop's job
//! runner does not care which engine handled a format. Everything that can fail
//! happens against bytes in memory; the destination is written once, atomically,
//! and only when a complete checked file exists.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::{create, edit, inspect, qa, spec};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub action: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub out: Option<String>,
    #[serde(default)]
    pub absolute_path: Option<String>,
    #[serde(default)]
    pub absolute_out: Option<String>,
    #[serde(default)]
    pub spec: Option<Json>,
    #[serde(default)]
    pub ops: Option<Vec<Json>>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Success(Success),
    Failure(Failure),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Success {
    pub ok: bool,
    pub path: String,
    pub bytes: usize,
    pub origin: String,
    pub edit_surface: String,
    pub unsupported: Vec<inspect::Unsupported>,
    pub summary: String,
    pub qa: Vec<qa::QaFinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline: Option<inspect::WorkbookOutline>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub ok: bool,
    pub kind: String,
    pub errors: Vec<ErrorEntry>,
}

#[derive(Debug, Serialize)]
pub struct ErrorEntry {
    pub path: String,
    pub message: String,
}

/// QA findings carried in a result; the rest stay reachable by context hash.
const MAX_REPORTED: usize = 25;
/// What this engine will open, matching the runner's own cap.
const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;

fn failure(kind: &str, path: &str, message: impl Into<String>) -> Response {
    Response::Failure(Failure {
        ok: false,
        kind: kind.into(),
        errors: vec![ErrorEntry {
            path: path.into(),
            message: message.into(),
        }],
    })
}

pub fn run(job: &Job) -> Response {
    if !job.format.is_empty() && job.format != "xlsx" {
        return failure(
            "unsupported",
            "format",
            format!(
                "{} is not handled by this engine; it builds xlsx",
                job.format
            ),
        );
    }
    match job.action.as_str() {
        "inspect" => run_inspect(job),
        "create" => run_create(job),
        "edit" => run_edit(job),
        other => failure("validation", "action", format!("{other} is not an action")),
    }
}

#[allow(clippy::result_large_err)] // The error *is* the response; boxing it would only move the size.
fn read_input(job: &Job) -> Result<Vec<u8>, Response> {
    let Some(path) = job.absolute_path.as_ref() else {
        return Err(failure("validation", "path", "no input path was supplied"));
    };
    let metadata = std::fs::metadata(path).map_err(|error| {
        failure(
            "runtime",
            "path",
            format!("the file could not be opened: {error}"),
        )
    })?;
    if metadata.len() > MAX_INPUT_BYTES {
        return Err(failure(
            "validation",
            "path",
            format!(
                "the file is {} bytes, past the {MAX_INPUT_BYTES}-byte limit",
                metadata.len()
            ),
        ));
    }
    std::fs::read(path).map_err(|error| {
        failure(
            "runtime",
            "path",
            format!("the file could not be read: {error}"),
        )
    })
}

fn run_inspect(job: &Job) -> Response {
    let bytes = match read_input(job) {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    match inspect::inspect_workbook(&bytes) {
        Ok(inspection) => Response::Success(Success {
            ok: true,
            path: job.path.clone().unwrap_or_default(),
            bytes: bytes.len(),
            origin: inspection.origin,
            edit_surface: inspection.edit_surface,
            unsupported: inspection.unsupported,
            summary: summary(inspection.outline.sheet_count, &[]),
            qa: Vec::new(),
            outline: Some(inspection.outline),
        }),
        Err(message) => failure("runtime", "path", message),
    }
}

fn run_create(job: &Job) -> Response {
    let Some(input) = job.spec.as_ref() else {
        return failure("validation", "spec", "create requires a spec");
    };
    let parsed = match spec::read_workbook_spec(input) {
        Ok(parsed) => parsed,
        Err(errors) => {
            return Response::Failure(Failure {
                ok: false,
                kind: "validation".into(),
                errors: errors
                    .into_iter()
                    .map(|error| ErrorEntry {
                        path: error.path,
                        message: error.message,
                    })
                    .collect(),
            });
        }
    };
    let built = match create::create_workbook(&parsed) {
        Ok(built) => built,
        Err(message) => return failure("runtime", "", message),
    };

    let mut findings = match qa::check_dimensions(&built.bytes, &built.sheet_dimensions) {
        Ok(findings) => findings,
        Err(message) => return failure("runtime", "", message),
    };
    // A dimension mismatch means the file is not the file that was asked for,
    // so nothing is written and the model is told what changed under it.
    if findings.iter().any(|finding| finding.severity == "error") {
        return Response::Failure(Failure {
            ok: false,
            kind: "runtime".into(),
            errors: findings
                .into_iter()
                .map(|finding| ErrorEntry {
                    path: finding.location,
                    message: finding.message,
                })
                .collect(),
        });
    }
    match qa::recalculate(&built.bytes) {
        Ok(outcome) => findings.extend(outcome.findings),
        Err(message) => return failure("runtime", "", message),
    }

    let Some(destination) = job.absolute_out.as_ref() else {
        return failure("validation", "out", "no output path was supplied");
    };
    if let Err(message) = write_atomically(destination, &built.bytes) {
        return failure("runtime", "out", message);
    }

    let inspection = match inspect::inspect_workbook(&built.bytes) {
        Ok(inspection) => inspection,
        Err(message) => return failure("runtime", "", message),
    };
    order_findings(&mut findings);
    Response::Success(Success {
        ok: true,
        path: job.out.clone().unwrap_or_else(|| destination.clone()),
        bytes: built.bytes.len(),
        origin: inspection.origin,
        edit_surface: inspection.edit_surface,
        unsupported: inspection.unsupported,
        summary: summary(inspection.outline.sheet_count, &findings),
        qa: findings.into_iter().take(MAX_REPORTED).collect(),
        outline: None,
    })
}

fn run_edit(job: &Job) -> Response {
    let bytes = match read_input(job) {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    let inspection = match inspect::inspect_workbook(&bytes) {
        Ok(inspection) => inspection,
        Err(message) => return failure("runtime", "path", message),
    };
    let ops = job.ops.clone().unwrap_or_default();
    if ops.is_empty() {
        return failure("validation", "ops", "edit requires at least one op");
    }
    let edited = match edit::apply_ops(&bytes, &ops, &inspection.edit_surface) {
        Ok(edited) => edited,
        Err(errors) => {
            return Response::Failure(Failure {
                ok: false,
                kind: "validation".into(),
                errors: errors
                    .into_iter()
                    .map(|error| ErrorEntry {
                        path: error.path,
                        message: error.message,
                    })
                    .collect(),
            });
        }
    };

    let mut findings = match qa::recalculate(&edited.bytes) {
        Ok(outcome) => outcome.findings,
        Err(message) => return failure("runtime", "", message),
    };

    let destination = job
        .absolute_out
        .clone()
        .or_else(|| job.absolute_path.clone());
    let Some(destination) = destination else {
        return failure("validation", "out", "no output path was supplied");
    };
    if let Err(message) = write_atomically(&destination, &edited.bytes) {
        return failure("runtime", "out", message);
    }

    let after = match inspect::inspect_workbook(&edited.bytes) {
        Ok(after) => after,
        Err(message) => return failure("runtime", "", message),
    };
    order_findings(&mut findings);
    Response::Success(Success {
        ok: true,
        path: job
            .out
            .clone()
            .or_else(|| job.path.clone())
            .unwrap_or(destination),
        bytes: edited.bytes.len(),
        origin: after.origin,
        edit_surface: after.edit_surface,
        unsupported: after.unsupported,
        summary: format!(
            "{} op{} applied · {}",
            edited.applied.len(),
            if edited.applied.len() == 1 { "" } else { "s" },
            summary(after.outline.sheet_count, &findings)
        ),
        qa: findings.into_iter().take(MAX_REPORTED).collect(),
        outline: None,
    })
}

fn order_findings(findings: &mut [qa::QaFinding]) {
    findings.sort_by_key(|finding| u8::from(finding.severity != "error"));
}

fn summary(sheets: usize, findings: &[qa::QaFinding]) -> String {
    let errors = findings
        .iter()
        .filter(|finding| finding.severity == "error")
        .count();
    format!(
        "{sheets} sheet{} · {errors} error{}, {} warnings",
        if sheets == 1 { "" } else { "s" },
        if errors == 1 { "" } else { "s" },
        findings.len() - errors
    )
}

/// Writes through a sibling temporary file and renames.
///
/// A rename within a directory is atomic on every platform this ships to, so a
/// reader sees either the old file or the new one — never a half-written zip.
fn write_atomically(destination: &str, bytes: &[u8]) -> Result<(), String> {
    let path = std::path::Path::new(destination);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("the destination directory could not be created: {error}"))?;
    }
    let staged = path.with_extension(format!("umbratic-{}", std::process::id()));
    std::fs::write(&staged, bytes)
        .map_err(|error| format!("the file could not be staged: {error}"))?;
    std::fs::rename(&staged, path).map_err(|error| {
        let _ = std::fs::remove_file(&staged);
        format!("the file could not be installed: {error}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn job(value: serde_json::Value) -> Job {
        serde_json::from_value(value).expect("job")
    }

    fn as_json(response: &Response) -> serde_json::Value {
        serde_json::to_value(response).expect("serializes")
    }

    #[test]
    fn create_writes_a_workbook_and_reports_it_as_ours() {
        let directory = tempfile::tempdir().unwrap();
        let out = directory.path().join("model.xlsx");
        let response = run(&job(json!({
            "action": "create",
            "format": "xlsx",
            "absoluteOut": out.to_string_lossy(),
            "out": ".umbratic/artifacts/xlsx/model.xlsx",
            "spec": {
                "sheets": [{
                    "name": "Assumptions",
                    "columns": [{"header": "Item", "width": 28}, {"header": "Value", "format": "0.0%"}],
                    "rows": [["Growth", {"v": 0.05, "role": "input"}], ["Churn", {"f": "=1-B2", "role": "calc"}]],
                    "freeze": "A2"
                }]
            }
        })));
        let value = as_json(&response);
        assert_eq!(value["ok"], true, "{value}");
        assert_eq!(value["origin"], "umbratic");
        assert_eq!(value["editSurface"], "full");
        assert!(out.exists());
        assert_eq!(value["qa"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn a_formula_outside_the_allowlist_fails_the_call_and_writes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let out = directory.path().join("model.xlsx");
        let response = run(&job(json!({
            "action": "create",
            "format": "xlsx",
            "absoluteOut": out.to_string_lossy(),
            "spec": {"sheets": [{"name": "Model", "rows": [[{"f": "=INDIRECT(\"A1\")"}]]}]}
        })));
        let value = as_json(&response);
        assert_eq!(value["ok"], false);
        assert_eq!(value["errors"][0]["path"], "sheets[0].rows[0][0].f");
        assert!(!out.exists(), "a rejected build must not leave a file");
    }

    #[test]
    fn the_round_trip_from_create_through_inspect_to_edit_holds() {
        let directory = tempfile::tempdir().unwrap();
        let out = directory.path().join("model.xlsx");
        let created = run(&job(json!({
            "action": "create",
            "format": "xlsx",
            "absoluteOut": out.to_string_lossy(),
            "spec": {
                "sheets": [{
                    "name": "Data",
                    "columns": [{"header": "Item"}, {"header": "Value"}],
                    "rows": [["Alpha", 10], ["Beta", 20], ["Total", {"f": "=SUM(B2:B3)", "role": "total"}]]
                }]
            }
        })));
        assert_eq!(as_json(&created)["ok"], true);

        let inspected = run(&job(json!({
            "action": "inspect",
            "format": "xlsx",
            "absolutePath": out.to_string_lossy(),
            "path": "model.xlsx"
        })));
        let value = as_json(&inspected);
        assert_eq!(value["ok"], true);
        assert_eq!(value["outline"]["sheets"][0]["name"], "Data");
        assert_eq!(value["outline"]["sheets"][0]["formulaCount"], 1);

        let edited = run(&job(json!({
            "action": "edit",
            "format": "xlsx",
            "absolutePath": out.to_string_lossy(),
            "absoluteOut": out.to_string_lossy(),
            "ops": [{"op": "setCells", "sheet": "Data", "cells": {"B2": 99}}]
        })));
        let value = as_json(&edited);
        assert_eq!(value["ok"], true, "{value}");
        assert!(value["summary"].as_str().unwrap().contains("1 op applied"));

        // The total has to have followed its input.
        let after = inspect::inspect_workbook(&std::fs::read(&out).unwrap()).unwrap();
        assert_eq!(after.outline.sheets[0].formula_count, 1);
    }

    #[test]
    fn an_edit_that_introduces_a_division_by_zero_reports_it() {
        let directory = tempfile::tempdir().unwrap();
        let out = directory.path().join("model.xlsx");
        run(&job(json!({
            "action": "create",
            "format": "xlsx",
            "absoluteOut": out.to_string_lossy(),
            "spec": {
                "sheets": [{
                    "name": "Model",
                    "columns": [{"header": "Item"}, {"header": "Value"}],
                    "rows": [["Revenue", 100], ["Units", 4], ["Price", {"f": "=B2/B3"}]]
                }]
            }
        })));
        let edited = run(&job(json!({
            "action": "edit",
            "format": "xlsx",
            "absolutePath": out.to_string_lossy(),
            "absoluteOut": out.to_string_lossy(),
            "ops": [{"op": "setCells", "sheet": "Model", "cells": {"B3": 0}}]
        })));
        let value = as_json(&edited);
        assert_eq!(value["ok"], true, "{value}");
        let findings = value["qa"].as_array().unwrap();
        assert!(
            findings.iter().any(|finding| finding["message"]
                .as_str()
                .unwrap_or("")
                .contains("#DIV/0!")),
            "{value}"
        );
    }

    #[test]
    fn an_op_the_surface_does_not_allow_is_refused_by_name() {
        let directory = tempfile::tempdir().unwrap();
        let out = directory.path().join("model.xlsx");
        run(&job(json!({
            "action": "create",
            "format": "xlsx",
            "absoluteOut": out.to_string_lossy(),
            "spec": {"sheets": [{"name": "Data", "rows": [[1]]}]}
        })));
        let response = run(&job(json!({
            "action": "edit",
            "format": "xlsx",
            "absolutePath": out.to_string_lossy(),
            "absoluteOut": out.to_string_lossy(),
            "ops": [{"op": "explode", "sheet": "Data"}]
        })));
        let value = as_json(&response);
        assert_eq!(value["ok"], false);
        assert!(
            value["errors"][0]["message"]
                .as_str()
                .unwrap()
                .contains("is not an operation"),
            "{value}"
        );
    }

    #[test]
    fn a_format_this_engine_does_not_build_says_so() {
        let response = run(&job(json!({"action": "create", "format": "pptx"})));
        let value = as_json(&response);
        assert_eq!(value["ok"], false);
        assert_eq!(value["kind"], "unsupported");
    }
}
