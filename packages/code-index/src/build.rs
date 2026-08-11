//! Full workspace build: scan, parse once, resolve, write atomically.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use chrono::Utc;
use sha2::{Digest, Sha256};

use crate::{
    cache::{self, CachedFile, ExtractCache},
    lang::Language,
    model::{Graph, IndexedFile, MAX_ARTIFACT_BYTES, posix_path, write_atomic},
    walk,
};

/// Mirrors `is_generated_runtime_path` in `packages/runner/src/policy.rs`, plus
/// `.umbratic/index/` for our own artifact. The lists are duplicated rather
/// than shared; `tests/exclusion_parity.rs` fails if they drift.
pub fn is_excluded_path(value: &str) -> bool {
    let normalized = value.replace('\\', "/").to_ascii_lowercase();
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    let prefixes = [
        ".umbratic/runtime/",
        ".umbratic/build/",
        ".umbratic/tmp/",
        ".umbratic/index/",
        ".venv/",
        "venv/",
        "node_modules/",
        ".git/",
        ".pytest_cache/",
        ".mypy_cache/",
        ".ruff_cache/",
        "build/",
        "dist/",
        "dist-electron/",
        "target/",
        "coverage/",
    ];
    let names = [
        "__pycache__",
        "cmakefiles",
        ".ds_store",
        "thumbs.db",
        "desktop.ini",
        "node_modules",
        ".git",
    ];
    let basename = parts.last().copied().unwrap_or("");
    prefixes.iter().any(|prefix| normalized.starts_with(prefix))
        || parts.iter().any(|part| names.contains(part))
        || matches!(basename, "cmakecache.txt" | "compile_commands.json")
}

/// A single file above this size is almost certainly generated or minified;
/// parsing it costs seconds and produces nodes nobody asked for.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Directory recursion depth guard for pathological or symlink-cycled trees.
const MAX_SCAN_DEPTH: usize = 40;

pub struct BuildSummary {
    pub files: usize,
    pub nodes: usize,
    pub edges: usize,
    pub artifact: PathBuf,
}

pub fn scan(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    collect(root, root, 0, &mut found);
    found.sort();
    found
}

fn collect(root: &Path, directory: &Path, depth: usize, found: &mut Vec<String>) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut sorted: Vec<_> = entries.flatten().collect();
    sorted.sort_by_key(std::fs::DirEntry::file_name);
    for entry in sorted {
        let path = entry.path();
        let Some(relative) = posix_path(root, &path) else {
            continue;
        };
        if is_excluded_path(&relative) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect(root, &path, depth + 1, found);
        } else if metadata.is_file()
            && metadata.len() <= MAX_FILE_BYTES
            && Language::from_path(&relative).is_some()
        {
            found.push(relative);
        }
    }
}

/// The one parsing entry point (A2). Every fact about a file derives from the
/// single buffer read here — language detection included. Re-opening the file
/// to sniff its language races with a concurrent save, and because the hash
/// gate skips unchanged files, the resulting wrong parse would be permanent.
pub fn parse_bytes(path: &str, bytes: &[u8]) -> Option<CachedFile> {
    let language = Language::from_path(path)?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language.grammar()).ok()?;
    let tree = parser.parse(bytes, None)?;
    Some(CachedFile {
        indexed: IndexedFile {
            hash,
            size: bytes.len() as u64,
            language: Some(language.name().to_owned()),
            indexed_at: Utc::now().to_rfc3339(),
        },
        language,
        extract: walk::extract(language, bytes, &tree),
    })
}

/// Rejects anything git could read as a flag or a shell metacharacter. Every
/// git call in this crate uses argv arrays, never a shell.
pub fn is_safe_git_ref(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.~^/@{}-".contains(c))
}

pub fn git_revision(root: &Path) -> String {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output();
    match output {
        Ok(result) if result.status.success() => {
            String::from_utf8_lossy(&result.stdout).trim().to_owned()
        }
        // Not a repository, or a repository with no commits. The graph is still
        // valid; only incremental update needs a base, and it rebuilds fully
        // when the recorded revision does not resolve.
        _ => "unversioned".to_owned(),
    }
}

pub fn build(root: &Path, artifact: &Path) -> Result<BuildSummary, String> {
    let mut cache = ExtractCache {
        revision: git_revision(root),
        files: BTreeMap::new(),
    };
    for path in scan(root) {
        let Ok(bytes) = fs::read(root.join(&path)) else {
            continue;
        };
        // A file the parser rejects costs that file, never the build: the graph
        // simply does not know about it.
        let Some(parsed) = parse_bytes(&path, &bytes) else {
            continue;
        };
        cache.files.insert(path, parsed);
    }
    finalize(root, artifact, cache)
}

/// Shared tail of `build` and `update`: resolve, write both files, report.
pub fn finalize(root: &Path, artifact: &Path, cache: ExtractCache) -> Result<BuildSummary, String> {
    let graph = cache::graph_from(root, &cache);
    write_graph(artifact, &graph)?;
    cache::save(artifact, &cache)?;
    Ok(BuildSummary {
        files: graph.files.len(),
        nodes: graph.nodes.len(),
        edges: graph.edges.len(),
        artifact: artifact.to_path_buf(),
    })
}

pub fn write_graph(artifact: &Path, graph: &Graph) -> Result<(), String> {
    let bytes = serde_json::to_vec(graph).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        // Fail toward "no graph" rather than a partial lie: an artifact the
        // runner would refuse anyway is worse than none.
        return Err("workspace graph exceeds the 32 MiB artifact budget".to_owned());
    }
    write_atomic(artifact, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::workspace_fingerprint;

    #[test]
    fn excluded_paths_cover_generated_trees_and_our_own_artifact() {
        assert!(is_excluded_path("node_modules/x/index.js"));
        assert!(is_excluded_path("target/debug/build.rs"));
        assert!(is_excluded_path(".umbratic/index/graph.json"));
        assert!(is_excluded_path("src/__pycache__/a.py"));
        assert!(!is_excluded_path("src/build.ts"));
    }

    #[test]
    fn git_refs_with_flags_or_metacharacters_are_rejected() {
        assert!(is_safe_git_ref("HEAD"));
        assert!(is_safe_git_ref("a1b2c3d"));
        assert!(!is_safe_git_ref("--upload-pack=evil"));
        assert!(!is_safe_git_ref("a;rm -rf /"));
        assert!(!is_safe_git_ref(""));
    }

    #[test]
    fn build_produces_a_loadable_graph_for_a_small_tree() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/store.ts"), "export function save() {}\n").unwrap();
        fs::write(
            root.join("src/service.ts"),
            "import { save } from './store';\nexport function createUser() { save(); }\n",
        )
        .unwrap();
        let artifact = root.join(".umbratic/index/graph.json");
        let summary = build(root, &artifact).expect("build succeeds");
        assert_eq!(summary.files, 2);
        assert!(summary.nodes >= 4);
        let graph: Graph =
            serde_json::from_slice(&fs::read(&artifact).unwrap()).expect("artifact parses");
        assert_eq!(graph.workspace_fingerprint, workspace_fingerprint(root));
        assert!(graph.nodes.windows(2).all(|pair| pair[0].id < pair[1].id));
    }

    #[test]
    fn two_builds_of_an_unchanged_tree_are_byte_identical() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.py"), "def save():\n    pass\n").unwrap();
        fs::write(root.join("src/b.py"), "from a import save\n").unwrap();
        let normalize = |path: &Path| {
            let mut graph: Graph = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            // Timestamps are the only fields allowed to differ (A9.1).
            graph.built_at = "fixed".into();
            for file in graph.files.values_mut() {
                file.indexed_at = "fixed".into();
            }
            serde_json::to_vec(&graph).unwrap()
        };
        let first = root.join("first.json");
        let second = root.join("second.json");
        build(root, &first).unwrap();
        build(root, &second).unwrap();
        assert_eq!(normalize(&first), normalize(&second));
    }
}
