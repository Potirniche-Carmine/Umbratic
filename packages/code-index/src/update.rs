//! Incremental update (A6). Decides what changed with git, re-parses only
//! those files, and re-runs the full resolution over the cached extracts.

use std::{collections::BTreeSet, fs, path::Path, process::Command};

use sha2::{Digest, Sha256};

use crate::{
    build::{self, BuildSummary, is_excluded_path, is_safe_git_ref},
    cache::{self, ExtractCache},
    lang::Language,
};

/// What the diff told us to do, before any file is read.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ChangeSet {
    /// Paths to re-read and possibly re-parse.
    pub candidates: BTreeSet<String>,
    /// Paths whose nodes and edges must disappear entirely.
    pub purged: BTreeSet<String>,
}

/// Parses `git diff --name-status -z` output. Records are NUL-separated and
/// rename/copy records carry **two** paths; missing the old one leaks its nodes
/// into the graph forever.
pub fn parse_name_status(raw: &str) -> ChangeSet {
    let mut change = ChangeSet::default();
    let mut fields = raw.split('\0').filter(|field| !field.is_empty());
    while let Some(status) = fields.next() {
        let Some(first) = fields.next() else { break };
        if status.starts_with('R') || status.starts_with('C') {
            let Some(second) = fields.next() else { break };
            if status.starts_with('R') {
                change.purged.insert(first.to_owned());
            }
            change.candidates.insert(second.to_owned());
            continue;
        }
        if status.starts_with('D') {
            change.purged.insert(first.to_owned());
        } else {
            change.candidates.insert(first.to_owned());
        }
    }
    change
}

fn git(root: &Path, arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(root)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn revision_resolves(root: &Path, revision: &str) -> bool {
    is_safe_git_ref(revision)
        && git(
            root,
            &["rev-parse", "--verify", &format!("{revision}^{{commit}}")],
        )
        .is_some()
}

pub fn update(root: &Path, artifact: &Path) -> Result<BuildSummary, String> {
    let Some(mut cache) = cache::load(artifact) else {
        return build::build(root, artifact);
    };
    // An unresolvable base means a rebase, a shallow clone, or a wiped history.
    // Rebuilding fully is the only honest option — diffing against a wrong base
    // silently produces a graph that describes neither revision.
    if !revision_resolves(root, &cache.revision) {
        return build::build(root, artifact);
    }
    let Some(raw) = git(root, &["diff", "--name-status", "-z", &cache.revision]) else {
        return build::build(root, artifact);
    };
    let mut change = parse_name_status(&raw);
    // `git diff` says nothing about untracked files, and a newly created file
    // is exactly the case a fresh index most needs to see.
    if let Some(untracked) = git(root, &["ls-files", "--others", "--exclude-standard", "-z"]) {
        change.candidates.extend(
            untracked
                .split('\0')
                .filter(|p| !p.is_empty())
                .map(str::to_owned),
        );
    }
    apply(root, artifact, &mut cache, &change)
}

fn apply(
    root: &Path,
    artifact: &Path,
    cache: &mut ExtractCache,
    change: &ChangeSet,
) -> Result<BuildSummary, String> {
    for path in &change.purged {
        cache.files.remove(path);
    }
    for path in &change.candidates {
        if is_excluded_path(path) || Language::from_path(path).is_none() {
            continue;
        }
        let Ok(bytes) = fs::read(root.join(path)) else {
            // Reported as changed but unreadable: treat as gone.
            cache.files.remove(path);
            continue;
        };
        // git reports touched-but-identical files; the hash gate is what keeps
        // a save-with-no-edit from costing a re-parse.
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if cache
            .files
            .get(path)
            .is_some_and(|cached| cached.indexed.hash == hash)
        {
            continue;
        }
        match build::parse_bytes(path, &bytes) {
            // Whole-file replacement, never node-granular patching.
            Some(parsed) => {
                cache.files.insert(path.clone(), parsed);
            }
            None => {
                cache.files.remove(path);
            }
        }
    }
    // Reconcile: anything the cache still lists that is gone from disk or has
    // become excluded since the last build.
    let stale: Vec<String> = cache
        .files
        .keys()
        .filter(|path| is_excluded_path(path) || !root.join(path).is_file())
        .cloned()
        .collect();
    for path in stale {
        cache.files.remove(&path);
    }
    cache.revision = build::git_revision(root);
    build::finalize(root, artifact, std::mem::take(cache))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Graph;

    #[test]
    fn rename_records_purge_the_old_path_and_index_the_new_one() {
        let change =
            parse_name_status("R100\0src/old.ts\0src/new.ts\0M\0src/a.ts\0D\0src/gone.ts\0");
        assert!(change.purged.contains("src/old.ts"));
        assert!(change.purged.contains("src/gone.ts"));
        assert!(change.candidates.contains("src/new.ts"));
        assert!(change.candidates.contains("src/a.ts"));
        assert_eq!(change.candidates.len(), 2);
    }

    #[test]
    fn copy_records_keep_the_source_file_indexed() {
        let change = parse_name_status("C75\0src/a.ts\0src/b.ts\0");
        assert!(change.purged.is_empty());
        assert!(change.candidates.contains("src/b.ts"));
    }

    fn read_graph(path: &Path) -> Graph {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn applying_a_change_set_replaces_edited_files_and_drops_deleted_ones() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/store.ts"), "export function save() {}\n").unwrap();
        fs::write(root.join("src/old.ts"), "export function gone() {}\n").unwrap();
        let artifact = root.join(".umbratic/index/graph.json");
        build::build(root, &artifact).unwrap();
        assert!(
            read_graph(&artifact)
                .nodes
                .iter()
                .any(|n| n.label == "gone")
        );

        fs::remove_file(root.join("src/old.ts")).unwrap();
        fs::write(
            root.join("src/store.ts"),
            "export function save() {}\nexport function load() {}\n",
        )
        .unwrap();
        let mut cache = cache::load(&artifact).expect("cache written by build");
        let change = ChangeSet {
            candidates: BTreeSet::from(["src/store.ts".to_owned()]),
            purged: BTreeSet::from(["src/old.ts".to_owned()]),
        };
        apply(root, &artifact, &mut cache, &change).unwrap();

        let graph = read_graph(&artifact);
        assert!(graph.nodes.iter().any(|node| node.label == "load"));
        assert!(!graph.nodes.iter().any(|node| node.label == "gone"));
        assert!(!graph.files.contains_key("src/old.ts"));
    }

    #[test]
    fn an_unchanged_file_is_not_reparsed_but_still_reconciled() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("a.py"), "def save():\n    pass\n").unwrap();
        let artifact = root.join(".umbratic/index/graph.json");
        build::build(root, &artifact).unwrap();
        let mut cache = cache::load(&artifact).unwrap();
        let before = cache.files["a.py"].indexed.indexed_at.clone();
        let change = ChangeSet {
            candidates: BTreeSet::from(["a.py".to_owned()]),
            purged: BTreeSet::new(),
        };
        apply(root, &artifact, &mut cache, &change).unwrap();
        let after = cache::load(&artifact).unwrap();
        assert_eq!(after.files["a.py"].indexed.indexed_at, before);
    }
}
