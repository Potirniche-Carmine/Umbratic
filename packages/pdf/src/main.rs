//! `umbratic-pdf` CLI: inspects a PDF and prints one JSON object on stdout.
//!
//! Usage:
//!   umbratic-pdf inspect [--full] [--token-budget N] [--max-bytes N] <path>
//!   umbratic-pdf --version

use std::path::PathBuf;
use std::process::ExitCode;

use umbratic_pdf::{InspectOptions, inspect_file};

fn fail(code: &str, message: &str) -> ExitCode {
    println!(
        "{}",
        serde_json::json!({ "error": { "code": code, "message": message } })
    );
    // Mirrored on stderr for humans and packaging smoke tests; stdout stays a
    // single JSON object for the desktop caller.
    eprintln!("umbratic-pdf: {message}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--version") {
        println!("umbratic-pdf {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    if arguments.first().map(String::as_str) != Some("inspect") {
        return fail(
            "usage",
            "usage: umbratic-pdf inspect [--full] [--token-budget N] [--max-bytes N] <path>",
        );
    }
    let mut options = InspectOptions::default();
    let mut path: Option<PathBuf> = None;
    let mut rest = arguments[1..].iter();
    while let Some(argument) = rest.next() {
        match argument.as_str() {
            "--full" => options.extract = true,
            "--token-budget" => match rest.next().and_then(|value| value.parse::<usize>().ok()) {
                Some(value) => options.token_budget = Some(value),
                None => return fail("usage", "--token-budget requires a non-negative integer"),
            },
            "--max-bytes" => match rest.next().and_then(|value| value.parse::<u64>().ok()) {
                Some(value) if value > 0 => options.max_bytes = value,
                _ => return fail("usage", "--max-bytes requires a positive integer"),
            },
            other if !other.starts_with("--") && path.is_none() => {
                path = Some(PathBuf::from(other));
            }
            other => return fail("usage", &format!("unknown argument: {other}")),
        }
    }
    let Some(path) = path else {
        return fail("usage", "inspect requires a PDF path");
    };
    match inspect_file(&path, &options) {
        Ok(inspection) => match serde_json::to_string(&inspection) {
            Ok(payload) => {
                println!("{payload}");
                ExitCode::SUCCESS
            }
            Err(error) => fail("serialize", &error.to_string()),
        },
        Err(error) => fail(error.code(), &error.to_string()),
    }
}
