//! Cross-crate gates for the workspace graph: the two facts the producer and
//! the runner duplicate on purpose, the evaluation tasks run through real tool
//! dispatch, and the build/update performance budgets.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use umbratic_code_index::{build, update};
use umbratic_runner::workspace_graph::{WorkspaceGraphService, workspace_fingerprint};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/workspace-graph")
        .join(name)
}

/// Builds a fixture into a temp artifact and returns a live service over it.
/// The fingerprint is the producer's, so a mismatch here is a real bug rather
/// than a test artefact.
fn service_for(name: &str) -> WorkspaceGraphService {
    let root = fixture(name);
    let directory = Box::leak(Box::new(tempfile::tempdir().expect("temp dir")));
    let artifact = directory.path().join("graph.json");
    build::build(&root, &artifact).expect("producer builds the fixture");
    WorkspaceGraphService::new(root, artifact)
}

#[test]
fn producer_and_runner_agree_on_the_workspace_fingerprint() {
    let directory = tempfile::tempdir().unwrap();
    // Duplicated deliberately in both crates so neither has to depend on the
    // other at run time; identical output is the contract.
    assert_eq!(
        umbratic_code_index::model::workspace_fingerprint(directory.path()),
        workspace_fingerprint(directory.path())
    );
}

#[test]
fn producer_and_runner_agree_on_excluded_paths() {
    let cases = [
        "node_modules/left-pad/index.js",
        "apps/desktop/node_modules/pkg/index.js",
        "apps/desktop/.llama-cache/llama.cpp/README.md",
        "packages/runner/target/debug/thing.rs",
        "target/debug/thing.rs",
        "dist/bundle.js",
        ".git/config",
        "src/__pycache__/a.py",
        "coverage/lcov.info",
        ".venv/lib/x.py",
        "src/service.ts",
        "src/build.ts",
        "docs/plan.md",
    ];
    for case in cases {
        assert_eq!(
            build::is_excluded_path(case),
            umbratic_runner::policy::is_generated_runtime_path(case),
            "producer and runner disagree about {case}"
        );
    }
    // The one intentional difference: the producer also skips its own output,
    // which the runner excludes through the same generated-path list.
    assert!(build::is_excluded_path(".umbratic/index/graph.json"));
    assert!(umbratic_runner::policy::is_generated_runtime_path(
        ".umbratic/index/graph.json"
    ));
}

fn labels(response: &Value) -> Vec<String> {
    response["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|node| node["label"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn evaluation_tasks_pass_through_real_tool_dispatch() {
    let tasks: Vec<Value> = serde_json::from_slice(
        &fs::read(fixture("evaluation-tasks.json")).expect("evaluation tasks readable"),
    )
    .expect("evaluation tasks parse");
    assert!(!tasks.is_empty());
    for task in tasks {
        let id = task["id"].as_str().unwrap_or_default();
        let service = service_for(task["fixture"].as_str().expect("fixture named"));
        let response = service.query(&task["call"]);
        assert_eq!(
            response["freshness"], "fresh",
            "{id}: graph should be fresh"
        );

        if let Some(expected) = task["expectLabels"].as_array() {
            let found = labels(&response);
            for label in expected {
                let label = label.as_str().unwrap_or_default();
                assert!(
                    found.iter().any(|value| value == label),
                    "{id}: expected {label} among {found:?}"
                );
            }
            // The honest-no-answer case: an empty expectation must stay empty,
            // not be satisfied by whatever the matcher happened to return.
            if expected.is_empty() {
                assert!(found.is_empty(), "{id}: expected no answer, got {found:?}");
            }
        }
        if let Some(expected) = task["expectRelations"].as_array() {
            let relations: Vec<&str> = response["edges"]
                .as_array()
                .map(|edges| {
                    edges
                        .iter()
                        .filter_map(|edge| edge["relation"].as_str())
                        .collect()
                })
                .unwrap_or_default();
            for relation in expected {
                let relation = relation.as_str().unwrap_or_default();
                assert!(
                    relations.contains(&relation),
                    "{id}: expected a {relation} edge among {relations:?}"
                );
            }
        }
    }
}

#[test]
fn affected_scores_nearer_dependents_above_further_ones() {
    let service = service_for("typescript");
    let response = service.query(&json!({"action": "affected", "query": "save"}));
    let nodes = response["nodes"].as_array().expect("nodes array");
    assert!(nodes.len() >= 2);
    // The seed itself scores 1.0 and every hop decays, so scores must be
    // non-increasing down the list.
    let scores: Vec<f64> = nodes
        .iter()
        .filter_map(|node| node["score"].as_f64())
        .collect();
    assert_eq!(
        scores.len(),
        nodes.len(),
        "every affected node carries a score"
    );
    assert!(scores.windows(2).all(|pair| pair[0] >= pair[1]));
    assert_eq!(scores[0], 1.0);
}

#[test]
fn changes_reports_absence_rather_than_failing_when_no_insights_exist() {
    let service = service_for("typescript");
    let response = service.query(&json!({"action": "changes"}));
    assert_eq!(response["freshness"], "fresh");
    assert!(response["nodes"].as_array().expect("nodes").is_empty());
    assert!(
        response["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("No change analysis")
    );
}

/// Modelled on `performance.rs`: the gate scales for unoptimized test builds
/// so it measures a real regression rather than the profile it ran in.
#[test]
fn build_and_update_meet_their_time_budgets() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    for index in 0..5_000 {
        let module = root.join(format!("src/pkg{}", index % 50));
        fs::create_dir_all(&module).unwrap();
        fs::write(
            module.join(format!("file{index}.ts")),
            format!(
                "export function handler{index}(value: number) {{ return value + {index}; }}\n"
            ),
        )
        .unwrap();
    }
    let artifact = root.join(".umbratic/index/graph.json");

    let started = Instant::now();
    let summary = build::build(root, &artifact).expect("build succeeds");
    let full = started.elapsed();
    assert_eq!(summary.files, 5_000);

    fs::write(
        root.join("src/pkg0/file0.ts"),
        "export function handler0(value: number) { return value; }\nexport function extra() {}\n",
    )
    .unwrap();
    let started = Instant::now();
    update::update(root, &artifact).expect("update succeeds");
    let incremental = started.elapsed();

    eprintln!(
        "workspace graph: full build {}ms, incremental {}ms",
        full.as_millis(),
        incremental.as_millis()
    );
    let (full_limit, incremental_limit) = if cfg!(debug_assertions) {
        (Duration::from_secs(60), Duration::from_millis(6_000))
    } else {
        (Duration::from_secs(5), Duration::from_millis(300))
    };
    assert!(full < full_limit, "full build took {}ms", full.as_millis());
    assert!(
        incremental < incremental_limit,
        "incremental update took {}ms",
        incremental.as_millis()
    );
}

/// Small models mix `query` and `symbol` up constantly. Accepting whichever
/// arrived costs nothing and saves a repair round; the observed live session
/// that motivated this sent `{"action":"query","symbol":"recordEntry"}`.
#[test]
fn the_matcher_accepts_whichever_term_field_the_model_used() {
    let service = service_for("typescript");
    let by_query = service.query(&json!({"action": "query", "query": "save"}));
    let by_symbol = service.query(&json!({"action": "query", "symbol": "save"}));
    assert_eq!(labels(&by_query), labels(&by_symbol));
    assert!(labels(&by_query).iter().any(|label| label == "save"));
}

/// A term-less call used to match every node, because substring matching
/// against "" is always true — a malformed call dumped the whole graph and
/// presented it as an answer.
#[test]
fn a_call_with_no_search_term_returns_no_answer_rather_than_everything() {
    let service = service_for("typescript");
    let response = service.query(&json!({"action": "query"}));
    assert!(
        labels(&response).is_empty(),
        "a term-less query must not answer with the whole graph"
    );
}
