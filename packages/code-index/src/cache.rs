//! The per-file extract cache, written beside the graph.
//!
//! Resolution is global — stage 3 needs every symbol in the workspace — but
//! parsing is the expensive part and is per-file. Caching extracts lets an
//! incremental update re-parse only what changed while still re-running the
//! full resolution, which is what A6 means by "re-run stage 3; it's cheap".

use std::{collections::BTreeMap, path::Path};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    lang::Language,
    model::{Extractor, Graph, IndexedFile, workspace_fingerprint, write_atomic},
    resolve::{self, ParsedFile, Workspace},
    walk::FileExtract,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct CachedFile {
    pub indexed: IndexedFile,
    pub language: Language,
    pub extract: FileExtract,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ExtractCache {
    pub revision: String,
    pub files: BTreeMap<String, CachedFile>,
}

pub fn cache_path(artifact: &Path) -> std::path::PathBuf {
    artifact.with_file_name("extracts.json")
}

pub fn load(artifact: &Path) -> Option<ExtractCache> {
    serde_json::from_slice(&std::fs::read(cache_path(artifact)).ok()?).ok()
}

pub fn save(artifact: &Path, cache: &ExtractCache) -> Result<(), String> {
    write_atomic(
        &cache_path(artifact),
        &serde_json::to_vec(cache).map_err(|error| error.to_string())?,
    )
}

fn go_module(root: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(root.join("go.mod")).ok()?;
    contents.lines().find_map(|line| {
        line.strip_prefix("module ")
            .map(|value| value.trim().to_owned())
    })
}

/// Turns cached extracts into the artifact. Every ordering that reaches the
/// output is a sort or a `BTreeMap`, so this is deterministic by construction.
pub fn graph_from(root: &Path, cache: &ExtractCache) -> Graph {
    let parsed: Vec<ParsedFile> = cache
        .files
        .iter()
        .map(|(path, cached)| ParsedFile {
            path: path.clone(),
            language: cached.language,
            // The resolver only reads the extract; cloning keeps the cache
            // owning its data so it can be written back unchanged.
            extract: cached.extract.clone(),
        })
        .collect();
    let known = cache.files.keys().cloned().collect();
    let read = |relative: &str| std::fs::read_to_string(root.join(relative)).ok();
    let (nodes, edges) = resolve::resolve(
        &parsed,
        &Workspace {
            files: &known,
            go_module: go_module(root),
            read: &read,
        },
    );
    let mut graph = Graph {
        workspace_fingerprint: workspace_fingerprint(root),
        revision: cache.revision.clone(),
        built_at: Utc::now().to_rfc3339(),
        extractor: Extractor::current(),
        files: cache
            .files
            .iter()
            .map(|(path, cached)| (path.clone(), cached.indexed.clone()))
            .collect(),
        nodes,
        edges,
    };
    graph.finish();
    graph
}
