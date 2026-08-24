//! The sidecar entry point.
//!
//! One JSON job on stdin, one JSON result on stdout, and nothing else: no
//! sockets, no arguments carrying data, no environment. The desktop spawns it
//! per job and reads the answer, so a workbook that takes a process down costs
//! one job rather than the session.

use std::io::{Read, Write};

use umbratic_artifacts::job::{ErrorEntry, Failure, Job, Response, run};

/// A job description is small; anything larger is not one.
const MAX_JOB_BYTES: usize = 8 * 1024 * 1024;

fn main() {
    let mut input = String::new();
    if let Err(error) = std::io::stdin()
        .take(MAX_JOB_BYTES as u64 + 1)
        .read_to_string(&mut input)
    {
        emit(&refusal(format!("the job could not be read: {error}")));
        return;
    }
    if input.len() > MAX_JOB_BYTES {
        emit(&refusal(format!(
            "the job is larger than the {MAX_JOB_BYTES}-byte limit"
        )));
        return;
    }
    // A bare invocation prints usage and exits non-zero, the same convention the
    // other packaged Umbratic binaries follow — which is what the package
    // verification uses to confirm the right executable was staged.
    if input.trim().is_empty() {
        eprintln!(
            "umbratic-artifacts {}: usage: send one JSON job on stdin",
            env!("CARGO_PKG_VERSION")
        );
        std::process::exit(1);
    }
    let job: Job = match serde_json::from_str(&input) {
        Ok(job) => job,
        Err(error) => {
            emit(&refusal(format!("the job is not a valid request: {error}")));
            return;
        }
    };
    emit(&run(&job));
}

fn refusal(message: String) -> Response {
    Response::Failure(Failure {
        ok: false,
        kind: "validation".into(),
        errors: vec![ErrorEntry {
            path: String::new(),
            message,
        }],
    })
}

fn emit(response: &Response) {
    let encoded = serde_json::to_string(response)
        .unwrap_or_else(|_| r#"{"ok":false,"kind":"runtime","errors":[]}"#.to_owned());
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(encoded.as_bytes());
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}
