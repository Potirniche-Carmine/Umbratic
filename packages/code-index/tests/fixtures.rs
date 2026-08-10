//! The producer's acceptance suite. Every language fixture under
//! `packages/runner/tests/fixtures/workspace-graph/` is built into a real
//! artifact and asserted symbol by symbol.
//!
//! These fixtures existed before this crate and no test referenced them. They
//! are the source of truth for the node-type tables in `lang.rs`: when a
//! grammar renames a node type, one of these assertions fails instead of the
//! extractor quietly returning nothing.

use std::{fs, path::PathBuf};

use umbratic_code_index::{build, model::Graph};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../runner/tests/fixtures/workspace-graph")
        .join(name)
}

/// Builds into a temp directory so the fixture tree stays clean and the
/// artifact never lands where the repository's own scans would see it.
fn graph_for(name: &str) -> Graph {
    let directory = tempfile::tempdir().expect("temp dir");
    let artifact = directory.path().join("graph.json");
    build::build(&fixture(name), &artifact).expect("build succeeds");
    serde_json::from_slice(&fs::read(&artifact).expect("artifact written")).expect("artifact parses")
}

fn labels(graph: &Graph, kind: &str) -> Vec<String> {
    let mut found: Vec<String> = graph
        .nodes
        .iter()
        .filter(|node| node.kind == kind)
        .map(|node| node.label.clone())
        .collect();
    found.sort();
    found
}

fn has_call(graph: &Graph, from: &str, to: &str) -> bool {
    let id_of = |label: &str| {
        graph
            .nodes
            .iter()
            .find(|node| node.label == label)
            .map(|node| node.id.clone())
    };
    let (Some(from), Some(to)) = (id_of(from), id_of(to)) else {
        return false;
    };
    graph
        .edges
        .iter()
        .any(|edge| edge.relation == "calls" && edge.from == from && edge.to == to)
}

#[test]
fn typescript_fixture_resolves_a_cross_file_call_through_its_import() {
    let graph = graph_for("typescript");
    assert_eq!(labels(&graph, "function"), vec!["createUser", "save"]);
    assert!(has_call(&graph, "createUser", "save"));
    assert!(graph.edges.iter().any(|edge| edge.relation == "imports"));
}

#[test]
fn javascript_fixture_matches_the_typescript_shape() {
    let graph = graph_for("javascript");
    assert_eq!(labels(&graph, "function"), vec!["createUser", "save"]);
    assert!(has_call(&graph, "createUser", "save"));
}

#[test]
fn python_fixture_resolves_a_module_import() {
    let graph = graph_for("python");
    assert_eq!(labels(&graph, "function"), vec!["create_user", "save"]);
    assert!(has_call(&graph, "create_user", "save"));
}

#[test]
fn go_fixture_extracts_functions_and_a_same_file_call() {
    let graph = graph_for("go");
    assert_eq!(labels(&graph, "function"), vec!["greet", "main"]);
    assert!(has_call(&graph, "main", "greet"));
}

#[test]
fn c_fixture_resolves_a_quoted_include_and_a_same_file_call() {
    let graph = graph_for("c");
    assert!(labels(&graph, "function").contains(&"main".to_owned()));
    assert!(has_call(&graph, "main", "save"));
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.relation == "imports" && edge.to.ends_with("store.h"))
    );
}

#[test]
fn csharp_fixture_resolves_through_a_using_directive() {
    let graph = graph_for("csharp");
    assert_eq!(labels(&graph, "class"), vec!["Service", "Store"]);
    assert!(has_call(&graph, "CreateUser", "Save"));
    let method = graph
        .nodes
        .iter()
        .find(|node| node.label == "Save")
        .expect("method node");
    // The namespace, not the file stem, prefixes a C# qualified name.
    assert_eq!(
        method.qualified_name.as_deref(),
        Some("App.Storage.Store.Save")
    );
}

#[test]
fn cmake_fixture_extracts_targets_links_and_subdirectories() {
    let graph = graph_for("cmake");
    assert_eq!(labels(&graph, "target"), vec!["app", "core"]);
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.relation == "depends"),
        "target_link_libraries should produce a depends edge"
    );
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.relation == "imports" && edge.to.contains("lib/CMakeLists.txt")),
        "add_subdirectory should produce an import edge"
    );
}

#[test]
fn mixed_language_workspaces_index_every_language_present() {
    let graph = graph_for("mixed");
    let languages: Vec<&str> = {
        let mut found: Vec<&str> = graph
            .files
            .values()
            .filter_map(|file| file.language.as_deref())
            .collect();
        found.sort();
        found
    };
    assert_eq!(languages, vec!["go", "typescript"]);
}

#[test]
fn windows_and_posix_builds_agree_on_path_identity() {
    let graph = graph_for("typescript");
    for node in &graph.nodes {
        let Some(location) = &node.location else {
            continue;
        };
        assert!(
            !location.path.contains('\\'),
            "path {} must be POSIX",
            location.path
        );
        assert!(!location.path.starts_with('/'));
    }
    for path in graph.files.keys() {
        assert!(!path.contains('\\'), "indexed path {path} must be POSIX");
    }
}
