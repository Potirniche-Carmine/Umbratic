use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLocation {
    pub path: String,
    pub start_line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qualified_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<GraphLocation>,
    /// Impact score, present only on `affected` and `changes` results. Never
    /// read from the artifact — it is a property of one query, not of the node.
    #[serde(skip_serializing_if = "Option::is_none", skip_deserializing)]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub relation: String,
    pub confidence: String,
    pub evidence: String,
    pub source: GraphLocation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexedFile {
    hash: String,
    size: u64,
    language: Option<String>,
    indexed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceGraph {
    workspace_fingerprint: String,
    revision: String,
    built_at: String,
    extractor: Value,
    files: HashMap<String, IndexedFile>,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

struct GraphIndex {
    graph: WorkspaceGraph,
    nodes: HashMap<String, GraphNode>,
    outgoing: HashMap<String, Vec<GraphEdge>>,
    incoming: HashMap<String, Vec<GraphEdge>>,
}

type CachedGraphIndex = Arc<Mutex<Option<Result<Arc<GraphIndex>, String>>>>;

#[derive(Clone)]
pub struct WorkspaceGraphService {
    cwd: PathBuf,
    artifact_path: PathBuf,
    expected_fingerprint: String,
    cached: CachedGraphIndex,
}

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

fn validate_path(value: &str) -> Result<(), String> {
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.split('/').any(|part| part == "..")
        || normalized != value
        || value.is_empty()
    {
        return Err("graph path must be a normalized workspace-relative path".to_owned());
    }
    Ok(())
}

fn validate_graph(graph: &mut WorkspaceGraph) -> Result<(), String> {
    let mut ids = HashSet::new();
    for node in &graph.nodes {
        if node.id.trim().is_empty() || node.label.chars().any(char::is_control) {
            return Err("Invalid graph node".to_owned());
        }
        if !ids.insert(node.id.clone()) {
            return Err(format!("Duplicate graph node id: {}", node.id));
        }
        if let Some(location) = &node.location {
            validate_path(&location.path)?;
        }
    }
    let mut edge_ids = HashSet::new();
    for edge in &graph.edges {
        if !edge_ids.insert(edge.id.clone()) {
            return Err(format!("Duplicate graph edge id: {}", edge.id));
        }
        if !ids.contains(&edge.from) || !ids.contains(&edge.to) {
            return Err(format!("Graph edge {} references an unknown node", edge.id));
        }
        if !matches!(
            edge.confidence.as_str(),
            "extracted" | "inferred" | "ambiguous"
        ) {
            return Err("Unsupported edge confidence".to_owned());
        }
        validate_path(&edge.source.path)?;
    }
    for path in graph.files.keys() {
        validate_path(path)?;
    }
    graph.nodes.sort_by(|left, right| left.id.cmp(&right.id));
    graph.edges.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(())
}

impl GraphIndex {
    fn new(graph: WorkspaceGraph) -> Self {
        let nodes = graph
            .nodes
            .iter()
            .map(|node| (node.id.clone(), node.clone()))
            .collect();
        let mut outgoing: HashMap<String, Vec<GraphEdge>> = HashMap::new();
        let mut incoming: HashMap<String, Vec<GraphEdge>> = HashMap::new();
        for edge in &graph.edges {
            outgoing
                .entry(edge.from.clone())
                .or_default()
                .push(edge.clone());
            incoming
                .entry(edge.to.clone())
                .or_default()
                .push(edge.clone());
        }
        Self {
            graph,
            nodes,
            outgoing,
            incoming,
        }
    }
}

impl WorkspaceGraphService {
    pub fn new(cwd: PathBuf, artifact_path: PathBuf) -> Self {
        Self {
            expected_fingerprint: workspace_fingerprint(&cwd),
            cwd,
            artifact_path,
            cached: Arc::new(Mutex::new(None)),
        }
    }

    fn load(&self) -> Result<Arc<GraphIndex>, String> {
        if let Some(cached) = self.cached.lock().unwrap().clone() {
            return cached;
        }
        let result = (|| {
            let metadata = fs::metadata(&self.artifact_path).map_err(|error| error.to_string())?;
            if metadata.len() > 32 * 1024 * 1024 {
                return Err("Workspace graph artifact is too large".to_owned());
            }
            let mut graph: WorkspaceGraph = serde_json::from_slice(
                &fs::read(&self.artifact_path).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            validate_graph(&mut graph)?;
            if graph.workspace_fingerprint != self.expected_fingerprint {
                return Err("Graph artifact belongs to a different workspace".to_owned());
            }
            Ok(Arc::new(GraphIndex::new(graph)))
        })();
        *self.cached.lock().unwrap() = Some(result.clone());
        result
    }

    fn freshness(&self, index: &GraphIndex) -> (String, Vec<String>) {
        let built = DateTime::parse_from_rfc3339(&index.graph.built_at)
            .ok()
            .map(|value| value.timestamp_millis());
        for (relative, indexed) in &index.graph.files {
            let path = self.cwd.join(relative);
            let Ok(metadata) = fs::metadata(path) else {
                return ("stale".into(), vec!["An indexed workspace file is missing. Verify with search/find/read or refresh the graph.".into()]);
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as i64);
            if !metadata.is_file()
                || metadata.len() != indexed.size
                || built
                    .zip(modified)
                    .is_some_and(|(built, modified)| modified > built + 1000)
            {
                return ("stale".into(), vec!["Workspace files changed after this graph revision. Verify with search/find/read or refresh the graph.".into()]);
            }
        }
        ("fresh".into(), Vec::new())
    }

    fn matching(index: &GraphIndex, query: &str, limit: usize) -> Vec<GraphNode> {
        let query = query.to_ascii_lowercase();
        let mut nodes: Vec<_> = index
            .graph
            .nodes
            .iter()
            .filter(|node| {
                node.id.to_ascii_lowercase().contains(&query)
                    || node.label.to_ascii_lowercase().contains(&query)
                    || node
                        .qualified_name
                        .as_ref()
                        .is_some_and(|name| name.to_ascii_lowercase().contains(&query))
            })
            .cloned()
            .collect();
        nodes.sort_by_key(|node| {
            (
                !node.label.eq_ignore_ascii_case(&query),
                node.label.len(),
                node.id.clone(),
            )
        });
        nodes.truncate(limit);
        nodes
    }

    fn traverse(
        index: &GraphIndex,
        seeds: &[GraphNode],
        depth: usize,
        direction: &str,
        limit: usize,
    ) -> (Vec<GraphNode>, Vec<GraphEdge>) {
        let mut selected: HashSet<String> = seeds.iter().map(|node| node.id.clone()).collect();
        let mut edges = HashMap::new();
        let mut queue: VecDeque<_> = seeds.iter().map(|node| (node.id.clone(), 0)).collect();
        while let Some((id, level)) = queue.pop_front() {
            if level >= depth {
                continue;
            }
            let candidates = match direction {
                "incoming" => index
                    .incoming
                    .get(&id)
                    .into_iter()
                    .flatten()
                    .cloned()
                    .collect::<Vec<_>>(),
                "outgoing" => index
                    .outgoing
                    .get(&id)
                    .into_iter()
                    .flatten()
                    .cloned()
                    .collect::<Vec<_>>(),
                _ => index
                    .incoming
                    .get(&id)
                    .into_iter()
                    .flatten()
                    .chain(index.outgoing.get(&id).into_iter().flatten())
                    .cloned()
                    .collect(),
            };
            for edge in candidates {
                let neighbor = if edge.from == id {
                    edge.to.clone()
                } else {
                    edge.from.clone()
                };
                edges.insert(edge.id.clone(), edge);
                if selected.len() < limit && selected.insert(neighbor.clone()) {
                    queue.push_back((neighbor, level + 1));
                }
            }
        }
        (
            selected
                .into_iter()
                .filter_map(|id| index.nodes.get(&id).cloned())
                .collect(),
            edges.into_values().collect(),
        )
    }

    /// Depth-bounded max-product impact scoring (design note A5).
    ///
    /// Relations are stored dependent→dependency, so "what does changing this
    /// break" flows *against* most arrows; `tested_by` is the exception, stored
    /// production→test. That asymmetry lives in the direction table rather than
    /// in branching code. One best score per node — not path enumeration —
    /// because cyclic graphs have exponentially many paths but only one useful
    /// answer per node.
    fn impact(
        index: &GraphIndex,
        seeds: &[GraphNode],
        depth: usize,
        limit: usize,
    ) -> (Vec<GraphNode>, Vec<GraphEdge>) {
        fn weight(relation: &str) -> f64 {
            match relation {
                "calls" => 1.0,
                "inherits" | "implements" => 0.9,
                "tested_by" => 0.7,
                "references" | "depends" => 0.6,
                "imports" => 0.5,
                _ => 0.5,
            }
        }
        fn confidence(value: &str) -> Option<f64> {
            match value {
                "extracted" => Some(1.0),
                "inferred" => Some(0.8),
                // Ambiguous edges are kept in the artifact so `explain` can show
                // them, but traversing one would launder a guess into evidence.
                _ => None,
            }
        }
        const DECAY: f64 = 0.6;
        const FLOOR: f64 = 0.05;

        let mut best: HashMap<String, f64> =
            seeds.iter().map(|node| (node.id.clone(), 1.0)).collect();
        let mut frontier = best.clone();
        let mut edges: HashMap<String, GraphEdge> = HashMap::new();
        for _ in 0..depth {
            let mut next: HashMap<String, f64> = HashMap::new();
            let mut ordered: Vec<(&String, &f64)> = frontier.iter().collect();
            ordered.sort_by(|left, right| left.0.cmp(right.0));
            for (id, score) in ordered {
                // `contains` is never traversed: a changed file already seeds
                // every symbol in it, and following containment bridges into
                // unrelated structure through the file node.
                let incoming = index.incoming.get(id).into_iter().flatten();
                let outgoing = index.outgoing.get(id).into_iter().flatten();
                let candidates = incoming
                    .map(|edge| (edge, edge.from.clone()))
                    .filter(|(edge, _)| edge.relation != "tested_by")
                    .chain(
                        outgoing
                            .filter(|edge| edge.relation == "tested_by")
                            .map(|edge| (edge, edge.to.clone())),
                    );
                for (edge, neighbor) in candidates {
                    if edge.relation == "contains" {
                        continue;
                    }
                    let Some(confidence) = confidence(&edge.confidence) else {
                        continue;
                    };
                    let value = score * weight(&edge.relation) * confidence * DECAY;
                    if value <= FLOOR || value <= *next.get(&neighbor).unwrap_or(&0.0) {
                        continue;
                    }
                    next.insert(neighbor, value);
                    edges.insert(edge.id.clone(), edge.clone());
                }
            }
            next.retain(|id, value| *value > *best.get(id).unwrap_or(&0.0));
            if next.is_empty() {
                break;
            }
            for (id, value) in &next {
                best.insert(id.clone(), *value);
            }
            frontier = next;
        }

        let mut nodes: Vec<GraphNode> = best
            .iter()
            .filter_map(|(id, score)| {
                index.nodes.get(id).map(|node| {
                    let mut node = node.clone();
                    node.score = Some((score * 1000.0).round() / 1000.0);
                    node
                })
            })
            .collect();
        nodes.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.id.cmp(&right.id))
        });
        nodes.truncate(limit);
        let kept: HashSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
        let mut edges: Vec<GraphEdge> = edges
            .into_values()
            .filter(|edge| kept.contains(edge.from.as_str()) && kept.contains(edge.to.as_str()))
            .collect();
        edges.sort_by(|left, right| left.id.cmp(&right.id));
        (nodes, edges)
    }

    /// Reads `insights.json`, the sibling of the graph artifact. No new config
    /// key: the review panel and the model read the same file, so the ordering
    /// a user sees and the ordering the model is told are the same fact.
    fn changes(&self, index: &GraphIndex, limit: usize) -> (String, Vec<GraphNode>, Option<f64>) {
        let path = self.artifact_path.with_file_name("insights.json");
        let Ok(bytes) = fs::read(&path) else {
            return (
                "No change analysis is available for this workspace.".to_owned(),
                Vec::new(),
                None,
            );
        };
        let Ok(insights) = serde_json::from_slice::<Value>(&bytes) else {
            return (
                "Change analysis could not be read.".to_owned(),
                Vec::new(),
                None,
            );
        };
        let symbols = insights
            .get("symbols")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let untested = symbols
            .iter()
            .filter(|symbol| symbol.get("tested").and_then(Value::as_bool) == Some(false))
            .count();
        let nodes = symbols
            .iter()
            .take(limit)
            .filter_map(|symbol| {
                let id = symbol.get("id").and_then(Value::as_str)?;
                let mut node = index.nodes.get(id).cloned()?;
                node.score = symbol.get("risk").and_then(Value::as_f64);
                Some(node)
            })
            .collect();
        (
            format!("{} changed symbols, {untested} untested.", symbols.len()),
            nodes,
            insights.get("overallRisk").and_then(Value::as_f64),
        )
    }

    pub fn query(&self, args: &Value) -> Value {
        let Ok(index) = self.load() else {
            let warning = self
                .load()
                .err()
                .unwrap_or_else(|| "Workspace graph is unavailable".into());
            return json!({ "graphRevision": "unavailable", "freshness": "degraded", "generatedAt": Utc::now().to_rfc3339(), "summary": "Workspace graph evidence is unavailable. Continue with search/find/read as the source of truth.", "nodes": [], "edges": [], "warnings": [warning] });
        };
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("summary");
        let summary;
        let mut overall_risk = None;
        // Scored actions carry their own meaningful order; re-sorting by id
        // would throw away the ranking that is the whole point of the answer.
        let mut scored = false;
        let (mut nodes, mut edges) = if action == "changes" {
            let (text, nodes, risk) = self.changes(&index, 40);
            summary = text;
            overall_risk = risk;
            scored = true;
            (nodes, Vec::new())
        } else if action == "summary" {
            summary = format!(
                "Workspace graph contains {} nodes, {} edges, and {} indexed files.",
                index.graph.nodes.len(),
                index.graph.edges.len(),
                index.graph.files.len()
            );
            (
                index.graph.nodes.iter().take(20).cloned().collect(),
                Vec::new(),
            )
        } else if action == "path" {
            let from = Self::matching(
                &index,
                args.get("from").and_then(Value::as_str).unwrap_or(""),
                1,
            );
            let to = Self::matching(
                &index,
                args.get("to").and_then(Value::as_str).unwrap_or(""),
                1,
            );
            let mut found_nodes = from.clone();
            let mut found_edges = Vec::new();
            if let (Some(start), Some(target)) = (from.first(), to.first()) {
                let mut queue = VecDeque::from([(start.id.clone(), Vec::<GraphEdge>::new())]);
                let mut seen = HashSet::from([start.id.clone()]);
                while let Some((id, path)) = queue.pop_front() {
                    if id == target.id {
                        found_edges = path;
                        break;
                    }
                    for edge in index
                        .outgoing
                        .get(&id)
                        .into_iter()
                        .flatten()
                        .chain(index.incoming.get(&id).into_iter().flatten())
                    {
                        let next = if edge.from == id {
                            &edge.to
                        } else {
                            &edge.from
                        };
                        if seen.insert(next.clone()) {
                            let mut candidate = path.clone();
                            candidate.push(edge.clone());
                            queue.push_back((next.clone(), candidate));
                        }
                    }
                }
                let ids: HashSet<_> = found_edges
                    .iter()
                    .flat_map(|edge| [edge.from.clone(), edge.to.clone()])
                    .collect();
                found_nodes = ids
                    .into_iter()
                    .filter_map(|id| index.nodes.get(&id).cloned())
                    .collect();
            }
            summary = if found_edges.is_empty() {
                "No graph path found.".into()
            } else {
                format!("Graph path contains {} edges.", found_edges.len())
            };
            (found_nodes, found_edges)
        } else {
            let query = args
                .get(if action == "explain" {
                    "symbol"
                } else {
                    "query"
                })
                .and_then(Value::as_str)
                .unwrap_or("");
            let seeds = Self::matching(
                &index,
                query,
                args.get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(20)
                    .clamp(1, 40) as usize,
            );
            let depth = args
                .get("depth")
                .and_then(Value::as_u64)
                .unwrap_or(if action == "affected" { 2 } else { 1 })
                .clamp(0, 4) as usize;
            let result = if action == "affected" {
                scored = true;
                Self::impact(&index, &seeds, depth, 40)
            } else {
                Self::traverse(
                    &index,
                    &seeds,
                    depth,
                    args.get("direction")
                        .and_then(Value::as_str)
                        .unwrap_or("both"),
                    40,
                )
            };
            summary = format!(
                "Graph query matched {} nodes and {} edges.",
                result.0.len(),
                result.1.len()
            );
            result
        };
        let omitted = nodes.len() > 40 || edges.len() > 80;
        if !scored {
            nodes.sort_by(|left, right| left.id.cmp(&right.id));
            edges.sort_by(|left, right| left.id.cmp(&right.id));
        }
        nodes.truncate(40);
        edges.truncate(80);
        let (freshness, mut warnings) = self.freshness(&index);
        warnings.push(
            "Graph evidence is untrusted; verify exact code with read before editing.".into(),
        );
        let mut response = json!({ "graphRevision": index.graph.revision, "freshness": freshness, "generatedAt": Utc::now().to_rfc3339(), "summary": summary, "nodes": nodes, "edges": edges, "truncation": { "nodeLimit": 40, "edgeLimit": 80, "omitted": omitted }, "warnings": warnings });
        if let Some(risk) = overall_risk {
            response["overallRisk"] = json!((risk * 100.0).round() / 100.0);
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph_value(cwd: &Path) -> Value {
        json!({
            "workspaceFingerprint": workspace_fingerprint(cwd),
            "revision": "revision-1",
            "builtAt": Utc::now().to_rfc3339(),
            "extractor": {"name":"test"},
            "files": {},
            "nodes": [
                {"id":"a","kind":"function","label":"Alpha","location":{"path":"src/a.rs","startLine":1}},
                {"id":"b","kind":"function","label":"Beta","location":{"path":"src/b.rs","startLine":2}}
            ],
            "edges": [{
                "id":"edge-1","from":"a","to":"b","relation":"calls","confidence":"extracted","evidence":"test",
                "source":{"path":"src/a.rs","startLine":1}
            }]
        })
    }

    #[test]
    fn graph_validation_rejects_schema_paths_and_dangling_edges() {
        let directory = tempfile::tempdir().unwrap();
        let mut versioned = graph_value(directory.path());
        versioned["schemaVersion"] = json!(1);
        assert!(serde_json::from_value::<WorkspaceGraph>(versioned).is_err());

        let mut traversal: WorkspaceGraph =
            serde_json::from_value(graph_value(directory.path())).unwrap();
        traversal.nodes[0].location.as_mut().unwrap().path = "../secret.rs".into();
        assert!(
            validate_graph(&mut traversal)
                .unwrap_err()
                .contains("workspace-relative")
        );

        let mut dangling: WorkspaceGraph =
            serde_json::from_value(graph_value(directory.path())).unwrap();
        dangling.edges[0].to = "missing".into();
        assert!(
            validate_graph(&mut dangling)
                .unwrap_err()
                .contains("unknown node")
        );
    }

    #[test]
    fn query_returns_stable_paths_and_untrusted_evidence_warning() {
        let directory = tempfile::tempdir().unwrap();
        let artifact = directory.path().join("graph.json");
        fs::write(
            &artifact,
            serde_json::to_vec(&graph_value(directory.path())).unwrap(),
        )
        .unwrap();
        let service = WorkspaceGraphService::new(directory.path().to_path_buf(), artifact);
        let result = service.query(&json!({"action":"path","from":"Alpha","to":"Beta"}));
        assert_eq!(result["freshness"], "fresh");
        assert_eq!(result["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(result["edges"][0]["id"], "edge-1");
        assert!(
            result["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| { warning.as_str().unwrap_or_default().contains("untrusted") })
        );
    }

    #[test]
    fn fingerprint_mismatch_degrades_without_exposing_graph_data() {
        let directory = tempfile::tempdir().unwrap();
        let artifact = directory.path().join("graph.json");
        let mut graph = graph_value(directory.path());
        graph["workspaceFingerprint"] = Value::String("different-workspace".into());
        fs::write(&artifact, serde_json::to_vec(&graph).unwrap()).unwrap();
        let service = WorkspaceGraphService::new(directory.path().to_path_buf(), artifact);
        let result = service.query(&json!({"action":"summary"}));
        assert_eq!(result["freshness"], "degraded");
        assert!(result["nodes"].as_array().unwrap().is_empty());
        assert!(
            result["warnings"][0]
                .as_str()
                .unwrap()
                .contains("different workspace")
        );
    }

    #[test]
    fn changed_workspace_files_mark_graph_stale() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("tracked.rs"), "changed").unwrap();
        let artifact = directory.path().join("graph.json");
        let mut graph = graph_value(directory.path());
        graph["builtAt"] = Value::String("2020-01-01T00:00:00Z".into());
        graph["files"] = json!({"tracked.rs":{"hash":"old","size":1,"language":"rust","indexedAt":"2020-01-01T00:00:00Z"}});
        fs::write(&artifact, serde_json::to_vec(&graph).unwrap()).unwrap();
        let result = WorkspaceGraphService::new(directory.path().to_path_buf(), artifact)
            .query(&json!({"action":"summary"}));
        assert_eq!(result["freshness"], "stale");
    }
}
