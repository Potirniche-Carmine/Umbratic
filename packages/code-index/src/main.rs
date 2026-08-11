//! One-shot, non-networked CLI. Its only output is the JSON artifact the
//! runner re-validates, plus a one-line JSON status on stdout.

use std::{path::PathBuf, process::ExitCode};

use umbratic_code_index::{analyze, build, cache, model, update};

fn flag(arguments: &[String], name: &str) -> Option<String> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|position| arguments.get(position + 1))
        .cloned()
}

fn fail(message: &str) -> ExitCode {
    println!("{}", serde_json::json!({ "ok": false, "error": message }));
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = arguments.first().cloned() else {
        return fail(
            "usage: umbratic-code-index <build|update|analyze> --workspace <path> --out <path>",
        );
    };
    let Some(workspace) = flag(&arguments, "--workspace").map(PathBuf::from) else {
        return fail("--workspace is required");
    };
    if !workspace.is_dir() {
        return fail("--workspace must be an existing directory");
    }
    let artifact = flag(&arguments, "--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.join(".umbratic/index/graph.json"));

    match command.as_str() {
        "build" | "update" => {
            let result = if command == "build" {
                build::build(&workspace, &artifact)
            } else {
                update::update(&workspace, &artifact)
            };
            match result {
                Ok(summary) => {
                    println!(
                        "{}",
                        serde_json::json!({
                            "ok": true,
                            "artifactPath": summary.artifact.to_string_lossy(),
                            "files": summary.files,
                            "nodes": summary.nodes,
                            "edges": summary.edges,
                        })
                    );
                    ExitCode::SUCCESS
                }
                Err(error) => fail(&error),
            }
        }
        "analyze" => {
            let Some(base) = flag(&arguments, "--base") else {
                return fail("--base is required for analyze");
            };
            // The desktop owns the patch hash; insights must describe exactly
            // the diff the review panel is showing, not a diff computed twice.
            let patch_hash = flag(&arguments, "--patch-hash").unwrap_or_default();
            let Some(cached) = cache::load(&artifact) else {
                return fail("no workspace graph to analyze");
            };
            let graph = cache::graph_from(&workspace, &cached);
            let ranges = match analyze::changed_ranges(&workspace, &base) {
                Ok(ranges) => ranges,
                Err(error) => return fail(&error),
            };
            let insights = analyze::insights(&graph, &ranges, &patch_hash);
            let path = artifact.with_file_name("insights.json");
            if let Err(error) = analyze::write_insights(&path, &insights) {
                return fail(&error);
            }
            println!(
                "{}",
                serde_json::json!({
                    "ok": true,
                    "insightsPath": path.to_string_lossy(),
                    "changedSymbols": insights.symbols.len(),
                    "overallRisk": insights.overall_risk,
                })
            );
            ExitCode::SUCCESS
        }
        "fingerprint" => {
            // Lets the desktop and tests confirm both sides agree on identity
            // without reading the artifact.
            println!(
                "{}",
                serde_json::json!({
                    "ok": true,
                    "workspaceFingerprint": model::workspace_fingerprint(&workspace),
                })
            );
            ExitCode::SUCCESS
        }
        other => fail(&format!("unknown command: {other}")),
    }
}
