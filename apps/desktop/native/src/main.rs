use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::ExitCode,
};

use serde::Serialize;
use walkdir::{DirEntry, WalkDir};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchKind {
    File,
    Folder,
    All,
}

impl SearchKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "file" => Some(Self::File),
            "folder" => Some(Self::Folder),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    fn includes_files(self) -> bool {
        matches!(self, Self::File | Self::All)
    }

    fn includes_folders(self) -> bool {
        matches!(self, Self::Folder | Self::All)
    }
}

#[derive(Debug, Clone, Serialize)]
struct FileSearchResult {
    path: String,
    name: String,
    kind: &'static str,
}

fn ignored_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".umbratic"
            | ".venv"
            | "venv"
            | "node_modules"
            | "dist"
            | "dist-electron"
            | "target"
            | "build"
            | "coverage"
            | ".next"
            | ".vite"
            | ".llama-cache"
            | "vendor"
            | ".pytest_cache"
            | ".mypy_cache"
            | ".ruff_cache"
    )
}

fn blocked_path(relative: &str) -> bool {
    relative.split('/').any(|part| {
        let part = part.to_ascii_lowercase();
        matches!(
            part.as_str(),
            ".git" | ".ssh" | ".aws" | ".gnupg" | "node_modules" | ".env"
        ) || part.starts_with(".env.")
    })
}

fn allowed_entry(root: &Path, entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
    if entry.file_type().is_dir() && entry.file_name().to_str().is_some_and(ignored_directory) {
        return false;
    }
    !blocked_path(&relative.to_string_lossy().replace('\\', "/"))
}

fn add_result(
    results: &mut HashMap<String, FileSearchResult>,
    relative: String,
    kind: &'static str,
) {
    if relative.is_empty() || blocked_path(&relative) || results.contains_key(&relative) {
        return;
    }
    let name = Path::new(&relative)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&relative)
        .to_owned();
    results.insert(
        relative.clone(),
        FileSearchResult {
            path: relative,
            name,
            kind,
        },
    );
}

/// Ranks matches so what the user is typing surfaces first: names that start
/// with the query beat path segments that start with it, which beat plain
/// substring hits.
fn score(result: &FileSearchResult, query: &str) -> u8 {
    if query.is_empty() {
        return 0;
    }
    let name = result.name.to_lowercase();
    let path = result.path.to_lowercase();
    if name.starts_with(query) {
        0
    } else if path.split('/').any(|segment| segment.starts_with(query)) {
        1
    } else if name.contains(query) {
        2
    } else {
        3
    }
}

fn search_files(
    root: &Path,
    query: &str,
    limit: usize,
    kind: SearchKind,
) -> Result<Vec<FileSearchResult>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Unable to open search root: {error}"))?;
    if !root.is_dir() {
        return Err("Search root must be a directory.".into());
    }
    let query_lower = query.to_lowercase();
    let collection_limit = (limit * 8).max(80);
    let mut files = Vec::new();
    let mut folders = Vec::new();
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| allowed_entry(&root, entry))
        .filter_map(Result::ok)
    {
        if entry.depth() == 0 {
            continue;
        }
        let is_dir = entry.file_type().is_dir();
        if !is_dir && !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if is_dir {
            folders.push(relative);
        } else {
            files.push(relative);
        }
    }

    let mut results = HashMap::new();
    if kind.includes_folders() {
        for relative in &folders {
            if query_lower.is_empty() || relative.to_lowercase().contains(&query_lower) {
                add_result(&mut results, relative.clone(), "folder");
                if results.len() >= collection_limit {
                    break;
                }
            }
        }
    }
    if kind.includes_files() {
        for relative in &files {
            if query_lower.is_empty() || relative.to_lowercase().contains(&query_lower) {
                add_result(&mut results, relative.clone(), "file");
                if results.len() >= collection_limit {
                    break;
                }
            }
        }
    }
    let mut values = results.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        score(left, &query_lower)
            .cmp(&score(right, &query_lower))
            .then(left.path.len().cmp(&right.path.len()))
            .then(left.path.cmp(&right.path))
    });
    values.truncate(limit);
    Ok(values)
}

fn arguments() -> (Option<String>, HashMap<String, String>) {
    let mut values = env::args().skip(1);
    let command = values.next();
    let options = values
        .filter_map(|value| {
            let (key, value) = value.split_once('=')?;
            Some((key.trim_start_matches("--").to_owned(), value.to_owned()))
        })
        .collect();
    (command, options)
}

fn handle(command: Option<String>, options: HashMap<String, String>) -> Result<String, String> {
    if command.as_deref() != Some("search-files") {
        return Err(
            "usage: umbratic-desktop-core search-files --root=<path> --query=<text> --limit=<count> --kind=<file|folder|all>"
                .into(),
        );
    }
    let root = options
        .get("root")
        .map(PathBuf::from)
        .ok_or_else(|| "--root is required".to_string())?;
    let query = options.get("query").map(String::as_str).unwrap_or("");
    let limit = options
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(10)
        .clamp(1, 30);
    let kind = SearchKind::parse(options.get("kind").map(String::as_str).unwrap_or("file"))
        .ok_or_else(|| "--kind must be file, folder, or all".to_string())?;
    let results = search_files(&root, query, limit, kind)?;
    serde_json::to_string(&results)
        .map_err(|error| format!("Unable to serialize search results: {error}"))
}

fn main() -> ExitCode {
    let (command, options) = arguments();
    match handle(command, options) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;

    use super::*;

    fn path_result(path: &str) -> FileSearchResult {
        FileSearchResult {
            path: path.into(),
            name: Path::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(path)
                .to_owned(),
            kind: "file",
        }
    }

    #[test]
    fn score_prefers_prefix_matches_over_substring_matches() {
        let name_prefix = path_result("docs/umbratic-guide.md");
        let segment_prefix = path_result("umbratic/notes.md");
        let name_contains = path_result("docs/all-umbratic.md");
        let path_contains = path_result("docs/my-umbratic/readme.txt");
        assert!(score(&name_prefix, "umbr") < score(&segment_prefix, "umbr"));
        assert!(score(&segment_prefix, "umbr") < score(&name_contains, "umbr"));
        assert!(score(&name_contains, "umbr") < score(&path_contains, "umbr"));
    }

    #[test]
    fn search_returns_folders_and_honors_kind_filter() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("umbratic/nested")).unwrap();
        fs::write(directory.path().join("umbratic/umbratic.txt"), "hello").unwrap();

        let folders = search_files(directory.path(), "umbr", 10, SearchKind::Folder).unwrap();
        assert!(folders.iter().all(|result| result.kind == "folder"));
        assert_eq!(folders[0].path, "umbratic");

        let files = search_files(directory.path(), "umbr", 10, SearchKind::File).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "umbratic/umbratic.txt");
        assert_eq!(files[0].kind, "file");

        let all = search_files(directory.path(), "", 10, SearchKind::All).unwrap();
        let paths: Vec<&str> = all.iter().map(|result| result.path.as_str()).collect();
        assert!(paths.contains(&"umbratic"));
        assert!(paths.contains(&"umbratic/nested"));
        assert!(paths.contains(&"umbratic/umbratic.txt"));
    }

    #[test]
    fn generated_and_secret_directories_are_ignored() {
        assert!(ignored_directory("node_modules"));
        assert!(ignored_directory(".llama-cache"));
        assert!(ignored_directory("target"));
        assert!(blocked_path(".ssh/id_ed25519"));
        assert!(blocked_path("config/.env.local"));
        assert!(!blocked_path("src/main.rs"));
    }

    #[test]
    fn search_matches_names_only_and_skips_secret_paths_and_honors_limits() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("needle-first.txt"), "alpha").unwrap();
        fs::write(directory.path().join("needle-second.txt"), "beta").unwrap();
        fs::write(directory.path().join("contents-only.txt"), "needle").unwrap();
        fs::write(directory.path().join(".env.needle"), "secret").unwrap();

        let limited = search_files(directory.path(), "needle", 1, SearchKind::File).unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].path, "needle-first.txt");

        let results = search_files(directory.path(), "needle", 10, SearchKind::File).unwrap();
        let paths: Vec<&str> = results.iter().map(|result| result.path.as_str()).collect();
        assert_eq!(paths, ["needle-first.txt", "needle-second.txt"]);

        let file = directory.path().join("file.txt");
        fs::write(&file, "text").unwrap();
        assert_eq!(
            search_files(&file, "text", 10, SearchKind::File).unwrap_err(),
            "Search root must be a directory."
        );
    }

    #[test]
    fn search_does_not_follow_symlinks_out_of_the_root() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("needle.txt"), "secret").unwrap();
        let link = directory.path().join("escape");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(outside.path(), &link).unwrap();

        let results = search_files(directory.path(), "needle", 10, SearchKind::File).unwrap();
        assert!(
            results.is_empty(),
            "followed a symlink out of the root: {results:?}"
        );
    }

    #[test]
    fn malformed_arguments_are_refused() {
        assert!(
            handle(None, HashMap::new())
                .unwrap_err()
                .starts_with("usage:")
        );
        assert_eq!(
            handle(Some("search-files".into()), HashMap::new()).unwrap_err(),
            "--root is required"
        );
        let mut options = HashMap::new();
        options.insert("root".into(), "/tmp".into());
        options.insert("kind".into(), "everything".into());
        assert_eq!(
            handle(Some("search-files".into()), options).unwrap_err(),
            "--kind must be file, folder, or all"
        );
    }
}
