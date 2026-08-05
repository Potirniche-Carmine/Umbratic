//! End-to-end checks for the `umbratic-pdf` CLI JSON contract.

use std::process::Command;

use serde_json::Value;
use umbratic_pdf::fixtures::{FixturePage, build_pdf};

fn run_cli(arguments: &[&str]) -> (bool, Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_umbratic-pdf"))
        .args(arguments)
        .output()
        .expect("CLI runs");
    let stdout = String::from_utf8(output.stdout).expect("stdout is UTF-8");
    let payload: Value = serde_json::from_str(stdout.trim()).expect("stdout is one JSON object");
    (output.status.success(), payload)
}

#[test]
fn inspect_full_emits_route_and_markdown() {
    let directory = tempfile::tempdir().expect("tempdir");
    let pdf_path = directory.path().join("fixture.pdf");
    std::fs::write(
        &pdf_path,
        build_pdf(&[FixturePage::Text(
            "A native text page with enough characters to classify confidently.",
        )]),
    )
    .expect("fixture written");

    let (ok, payload) = run_cli(&["inspect", "--full", pdf_path.to_str().expect("utf8 path")]);
    assert!(ok);
    assert_eq!(payload["pdfType"], "text_based");
    assert_eq!(payload["pageCount"], 1);
    assert_eq!(payload["pagesNeedingOcr"], serde_json::json!([]));
    assert_eq!(payload["hasEncodingIssues"], false);
    assert!(payload["confidence"].as_f64().expect("confidence") >= 0.7);
    assert!(
        payload["markdown"]
            .as_str()
            .expect("markdown")
            .contains("native text page")
    );
    assert!(payload["estimatedTokens"].as_u64().expect("tokens") > 0);
}

#[test]
fn detect_mode_omits_markdown() {
    let directory = tempfile::tempdir().expect("tempdir");
    let pdf_path = directory.path().join("fixture.pdf");
    std::fs::write(&pdf_path, build_pdf(&[FixturePage::Images(1)])).expect("fixture written");

    let (ok, payload) = run_cli(&["inspect", pdf_path.to_str().expect("utf8 path")]);
    assert!(ok);
    assert_eq!(payload["pdfType"], "scanned");
    assert!(payload.get("markdown").is_none());
    assert_eq!(payload["pagesNeedingOcr"], serde_json::json!([1]));
}

#[test]
fn missing_file_reports_io_error_json() {
    let (ok, payload) = run_cli(&["inspect", "/nonexistent/never/there.pdf"]);
    assert!(!ok);
    assert_eq!(payload["error"]["code"], "io");
}

#[test]
fn usage_errors_are_json() {
    let (ok, payload) = run_cli(&["frobnicate"]);
    assert!(!ok);
    assert_eq!(payload["error"]["code"], "usage");
}
