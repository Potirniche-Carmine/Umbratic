//! Artifact types. These mirror `packages/runner/src/workspace_graph.rs`
//! field-for-field: the runner deserializes with `deny_unknown_fields`, so any
//! drift here fails the round-trip test in `tests/artifact.rs` rather than
//! silently producing an artifact the runner refuses to load.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Longest string that may reach the model through any artifact field. Source
/// identifiers are untrusted input; the cap matters as much as the control
/// character strip because an identifier can be a paragraph of injected prose.
pub const MAX_STRING: usize = 256;

/// Mirrors the runner's own limit. Past this the build fails toward "no graph"
/// rather than writing an artifact the runner will reject at load time.
pub const MAX_ARTIFACT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub path: String,
    pub start_line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u64>,
}

impl Location {
    pub fn new(path: &str, start_line: u64, end_line: u64) -> Self {
        Self {
            path: path.to_owned(),
            start_line: start_line.max(1),
            end_line: Some(end_line.max(start_line).max(1)),
            start_column: None,
            end_column: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qualified_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub relation: String,
    pub confidence: String,
    pub evidence: String,
    pub source: Location,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFile {
    pub hash: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub indexed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Graph {
    pub workspace_fingerprint: String,
    pub revision: String,
    pub built_at: String,
    pub extractor: Extractor,
    /// `BTreeMap`, not `HashMap`: serialized key order is part of the
    /// byte-identical determinism guarantee (A9).
    pub files: BTreeMap<String, IndexedFile>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extractor {
    pub id: String,
    pub version: String,
}

impl Extractor {
    pub fn current() -> Self {
        Self {
            id: "umbratic-code-index".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }
}

impl Graph {
    /// Sorting here rather than at every insertion point is what makes two
    /// builds of an unchanged tree byte-identical regardless of directory
    /// iteration order.
    pub fn finish(&mut self) {
        self.nodes.sort_by(|left, right| left.id.cmp(&right.id));
        self.nodes.dedup_by(|left, right| left.id == right.id);
        self.edges.sort_by(|left, right| left.id.cmp(&right.id));
        self.edges.dedup_by(|left, right| left.id == right.id);
        let ids: std::collections::HashSet<&str> =
            self.nodes.iter().map(|node| node.id.as_str()).collect();
        self.edges
            .retain(|edge| ids.contains(edge.from.as_str()) && ids.contains(edge.to.as_str()));
    }
}

/// Byte-identical to the runner's `workspace_fingerprint`. A mismatch makes the
/// runner discard the artifact as belonging to another workspace, so this
/// function is duplicated deliberately and guarded by a cross-crate test.
pub fn workspace_fingerprint(cwd: &Path) -> String {
    let canonical = cwd
        .canonicalize()
        .unwrap_or_else(|_| cwd.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();
    format!(
        "{:x}",
        Sha256::digest(format!("umbratic-workspace-v1\0{canonical}").as_bytes())
    )
}

/// Strip control characters and cap length. Applied to every string that
/// reaches the artifact — labels, qualified names, and evidence alike.
pub fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= MAX_STRING {
        return trimmed.to_owned();
    }
    trimmed.chars().take(MAX_STRING).collect()
}

/// Workspace-relative POSIX path. The runner's validator rejects `\`, a leading
/// `/`, and `..` components, so identity is established once, here.
pub fn posix_path(root: &Path, absolute: &Path) -> Option<String> {
    let relative = absolute.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

pub fn file_node_id(path: &str) -> String {
    format!("file:{path}")
}

pub fn symbol_node_id(path: &str, kind: &str, name: &str, start_line: u64) -> String {
    format!("symbol:{path}:{kind}:{name}:{start_line}")
}

/// Edge ids must be unique and stable, and nothing reads them for meaning —
/// consumers traverse `from`/`to`. Spelling the natural key out in full costs
/// roughly a fifth of the artifact on a real repository, so it is hashed: the
/// relation stays readable for debugging, the identity is a digest of
/// endpoints plus call site (two calls to the same target on one line are one
/// edge).
pub fn edge_id(relation: &str, from: &str, to: &str, line: u64) -> String {
    let digest = Sha256::digest(format!("{relation}\0{from}\0{to}\0{line}").as_bytes());
    format!("edge:{relation}:{:x}", digest)
        .chars()
        .take(relation.len() + 22)
        .collect()
}

/// Temp file in the same directory then rename, so a crashed build never leaves
/// a half-written artifact the runner would try to parse.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary: PathBuf = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_control_characters_and_caps_length() {
        assert_eq!(sanitize("na\u{0}me\n"), "name");
        assert_eq!(sanitize(&"x".repeat(400)).len(), MAX_STRING);
    }

    #[test]
    fn posix_path_rejects_escapes_and_joins_with_forward_slashes() {
        let root = Path::new("/work");
        assert_eq!(
            posix_path(root, Path::new("/work/src/a.ts")).as_deref(),
            Some("src/a.ts")
        );
        assert_eq!(posix_path(root, Path::new("/other/a.ts")), None);
    }

    #[test]
    fn finish_drops_edges_whose_endpoints_are_missing() {
        let mut graph = Graph {
            workspace_fingerprint: "f".into(),
            revision: "r".into(),
            built_at: "t".into(),
            extractor: Extractor::current(),
            files: BTreeMap::new(),
            nodes: vec![Node {
                id: "a".into(),
                kind: "function".into(),
                label: "a".into(),
                qualified_name: None,
                location: None,
            }],
            edges: vec![Edge {
                id: "e".into(),
                from: "a".into(),
                to: "missing".into(),
                relation: "calls".into(),
                confidence: "extracted".into(),
                evidence: "x".into(),
                source: Location::new("a.ts", 1, 1),
            }],
        };
        graph.finish();
        assert!(graph.edges.is_empty());
    }
}
