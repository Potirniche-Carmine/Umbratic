//! Change analysis (A7). Produces `insights.json` beside the graph — the one
//! source of truth for both the review panel's ordering and the `changes`
//! action's ordering, so the human and the model never see different priorities.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    process::Command,
};

use serde::{Deserialize, Serialize};

use crate::{
    build::{is_excluded_path, is_safe_git_ref},
    model::{Graph, write_atomic},
};

/// Substring matched against the lower-cased label and qualified name.
/// Deliberately high-recall: `execute` matching `executeBatch` is the intent.
const SECURITY_TERMS: [&str; 26] = [
    "auth",
    "login",
    "password",
    "token",
    "session",
    "crypt",
    "secret",
    "credential",
    "permission",
    "sql",
    "query",
    "execute",
    "connect",
    "socket",
    "request",
    "http",
    "sanitize",
    "validate",
    "encrypt",
    "decrypt",
    "hash",
    "sign",
    "verify",
    "admin",
    "privilege",
    "exec",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolInsight {
    pub id: String,
    pub label: String,
    pub path: String,
    pub line: u64,
    pub risk: f64,
    pub tested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Insights {
    pub patch_hash: String,
    pub overall_risk: f64,
    pub file_order: Vec<String>,
    pub symbols: Vec<SymbolInsight>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub test_gaps: Vec<String>,
}

/// `git diff --unified=0` gives ranges that are exactly the changed lines, with
/// no context to widen them into neighbouring symbols.
pub fn changed_ranges(
    root: &Path,
    base: &str,
) -> Result<BTreeMap<String, Vec<(u64, u64)>>, String> {
    if !is_safe_git_ref(base) {
        return Err("unsafe git ref".to_owned());
    }
    let output = Command::new("git")
        .args(["diff", "--unified=0", base, "--"])
        .current_dir(root)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("git diff failed".to_owned());
    }
    let mut ranges = parse_diff(&String::from_utf8_lossy(&output.stdout));
    // `git diff` says nothing about untracked files, but a file the turn
    // created is part of the diff the review panel shows — and a brand new
    // file is exactly the one nobody has reviewed yet.
    if let Ok(untracked) = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .current_dir(root)
        .output()
        && untracked.status.success()
    {
        for path in String::from_utf8_lossy(&untracked.stdout)
            .split('\0')
            // A workspace that has not gitignored `.umbratic/` would otherwise
            // see the index's own files ranked into its review order.
            .filter(|path| !path.is_empty() && !is_excluded_path(path))
        {
            ranges
                .entry(path.to_owned())
                .or_default()
                .push((1, u64::MAX));
        }
    }
    Ok(ranges)
}

pub fn parse_diff(diff: &str) -> BTreeMap<String, Vec<(u64, u64)>> {
    let mut ranges: BTreeMap<String, Vec<(u64, u64)>> = BTreeMap::new();
    let mut current: Option<String> = None;
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ b/") {
            current = (path != "/dev/null").then(|| path.trim().to_owned());
            continue;
        }
        let Some(rest) = line.strip_prefix("@@ ") else {
            continue;
        };
        let Some(target) = rest.split_whitespace().find(|part| part.starts_with('+')) else {
            continue;
        };
        let target = &target[1..];
        let (start, count) = match target.split_once(',') {
            Some((start, count)) => (start.parse::<u64>(), count.parse::<u64>().unwrap_or(1)),
            // A missing count means one line.
            None => (target.parse::<u64>(), 1),
        };
        let Ok(start) = start else { continue };
        let Some(path) = current.clone() else {
            continue;
        };
        // A count of zero is a pure deletion; collapse it to the position so
        // the deletion still maps to the symbol it happened in.
        let end = if count == 0 { start } else { start + count - 1 };
        ranges.entry(path).or_default().push((start, end));
    }
    ranges
}

fn security_name(label: &str, qualified: Option<&str>) -> bool {
    let haystack = format!("{label} {}", qualified.unwrap_or_default()).to_ascii_lowercase();
    SECURITY_TERMS.iter().any(|term| haystack.contains(term))
}

pub fn insights(
    graph: &Graph,
    ranges: &BTreeMap<String, Vec<(u64, u64)>>,
    patch_hash: &str,
) -> Insights {
    let mut tested: HashMap<&str, usize> = HashMap::new();
    let mut callers: HashMap<&str, usize> = HashMap::new();
    let mut importers: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    let node_path: HashMap<&str, &str> = graph
        .nodes
        .iter()
        .filter_map(|node| {
            node.location
                .as_ref()
                .map(|location| (node.id.as_str(), location.path.as_str()))
        })
        .collect();
    for edge in &graph.edges {
        match edge.relation.as_str() {
            "tested_by" => *tested.entry(edge.from.as_str()).or_default() += 1,
            "calls" => *callers.entry(edge.to.as_str()).or_default() += 1,
            "imports" => {
                if let Some(target) = node_path.get(edge.to.as_str()) {
                    importers
                        .entry(target)
                        .or_default()
                        .insert(edge.from.as_str());
                }
            }
            _ => {}
        }
    }

    let mut symbols = Vec::new();
    for node in &graph.nodes {
        if node.kind == "file" {
            continue;
        }
        let Some(location) = &node.location else {
            continue;
        };
        let Some(file_ranges) = ranges.get(&location.path) else {
            continue;
        };
        let end_line = location.end_line.unwrap_or(location.start_line);
        // Inclusive interval overlap (A7.2).
        if !file_ranges
            .iter()
            .any(|(start, stop)| location.start_line <= *stop && end_line >= *start)
        {
            continue;
        }
        let test_count = tested.get(node.id.as_str()).copied().unwrap_or(0);
        let reach = callers.get(node.id.as_str()).copied().unwrap_or(0)
            + importers
                .get(location.path.as_str())
                .map(BTreeSet::len)
                .unwrap_or(0);
        let risk = 0.40 * (1.0 - (test_count as f64 / 3.0).min(1.0))
            + 0.35 * (reach.min(15) as f64 / 15.0)
            + 0.25
                * f64::from(u8::from(security_name(
                    &node.label,
                    node.qualified_name.as_deref(),
                )));
        symbols.push(SymbolInsight {
            id: node.id.clone(),
            label: node.label.clone(),
            path: location.path.clone(),
            line: location.start_line,
            risk: (risk * 1000.0).round() / 1000.0,
            tested: test_count > 0,
        });
    }
    symbols.sort_by(|left, right| {
        right
            .risk
            .partial_cmp(&left.risk)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut per_file: BTreeMap<&str, f64> = BTreeMap::new();
    for symbol in &symbols {
        let entry = per_file.entry(symbol.path.as_str()).or_insert(0.0);
        *entry = entry.max(symbol.risk);
    }
    let mut file_order: Vec<(&str, f64)> = per_file.into_iter().collect();
    file_order.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.0.cmp(right.0))
    });
    // Changed files with no symbol coverage still belong in the ordering; they
    // sort after the scored ones so the panel never silently drops a file.
    let mut ordered: Vec<String> = file_order
        .iter()
        .map(|(path, _)| (*path).to_owned())
        .collect();
    for path in ranges.keys() {
        if !ordered.iter().any(|existing| existing == path) {
            ordered.push(path.clone());
        }
    }

    Insights {
        patch_hash: patch_hash.to_owned(),
        // Max, never mean: one dangerous change makes the diff dangerous.
        overall_risk: symbols
            .iter()
            .map(|symbol| symbol.risk)
            .fold(0.0_f64, f64::max),
        file_order: ordered,
        test_gaps: symbols
            .iter()
            .filter(|symbol| !symbol.tested)
            .map(|symbol| symbol.id.clone())
            .collect(),
        symbols,
    }
}

pub fn write_insights(path: &Path, insights: &Insights) -> Result<(), String> {
    write_atomic(
        path,
        &serde_json::to_vec(insights).map_err(|error| error.to_string())?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Extractor, Location, Node};

    fn graph_with(nodes: Vec<Node>) -> Graph {
        Graph {
            workspace_fingerprint: "f".into(),
            revision: "r".into(),
            built_at: "t".into(),
            extractor: Extractor::current(),
            files: BTreeMap::new(),
            nodes,
            edges: Vec::new(),
        }
    }

    fn symbol(id: &str, label: &str, start: u64, end: u64) -> Node {
        Node {
            id: id.into(),
            kind: "function".into(),
            label: label.into(),
            qualified_name: None,
            location: Some(Location::new("src/auth.ts", start, end)),
        }
    }

    #[test]
    fn zero_count_hunks_collapse_to_their_position() {
        let ranges = parse_diff("+++ b/src/a.ts\n@@ -10,2 +10,0 @@\n@@ -20 +18,3 @@\n");
        assert_eq!(ranges["src/a.ts"], vec![(10, 10), (18, 20)]);
    }

    #[test]
    fn only_symbols_overlapping_a_changed_range_are_reported() {
        let graph = graph_with(vec![
            symbol("a", "readItem", 1, 5),
            symbol("b", "validateSession", 20, 30),
        ]);
        let ranges = BTreeMap::from([("src/auth.ts".to_owned(), vec![(22, 22)])]);
        let result = insights(&graph, &ranges, "hash-1");
        assert_eq!(result.symbols.len(), 1);
        assert_eq!(result.symbols[0].label, "validateSession");
        assert_eq!(result.patch_hash, "hash-1");
    }

    #[test]
    fn security_named_untested_symbols_outrank_ordinary_ones() {
        let graph = graph_with(vec![
            symbol("a", "renderRow", 1, 5),
            symbol("b", "validateSession", 10, 15),
        ]);
        let ranges = BTreeMap::from([("src/auth.ts".to_owned(), vec![(1, 20)])]);
        let result = insights(&graph, &ranges, "hash-1");
        assert_eq!(result.symbols[0].label, "validateSession");
        assert!(result.overall_risk >= result.symbols[1].risk);
        assert_eq!(result.test_gaps.len(), 2);
    }
}
