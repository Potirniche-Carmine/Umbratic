use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
};

use serde::Serialize;
use walkdir::{DirEntry, WalkDir};

const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
struct FileSearchResult {
    path: String,
    name: String,
    #[serde(rename = "match")]
    match_kind: &'static str,
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
    match_kind: &'static str,
) {
    if relative.is_empty() || blocked_path(&relative) {
        return;
    }
    if results
        .get(&relative)
        .is_some_and(|existing| existing.match_kind == "path")
    {
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
            match_kind,
        },
    );
}

fn score(result: &FileSearchResult, query: &str) -> u8 {
    if query.is_empty() {
        return 0;
    }
    let name = result.name.to_lowercase();
    let path = result.path.to_lowercase();
    if name.starts_with(query) {
        0
    } else if path.starts_with(query) {
        1
    } else if name.contains(query) {
        2
    } else if path.contains(query) {
        3
    } else if result.match_kind == "content" {
        4
    } else {
        5
    }
}

fn search_files(root: &Path, query: &str, limit: usize) -> Result<Vec<FileSearchResult>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Unable to open search root: {error}"))?;
    if !root.is_dir() {
        return Err("Search root must be a directory.".into());
    }
    let query_lower = query.to_lowercase();
    let collection_limit = (limit * 8).max(80);
    let mut files = Vec::new();
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| allowed_entry(&root, entry))
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        files.push((entry.path().to_owned(), relative));
    }

    let mut results = HashMap::new();
    for (_, relative) in &files {
        if query_lower.is_empty() || relative.to_lowercase().contains(&query_lower) {
            add_result(&mut results, relative.clone(), "path");
            if results.len() >= collection_limit {
                break;
            }
        }
    }
    if query_lower.len() >= 2 && results.len() < collection_limit {
        for (absolute, relative) in &files {
            let Ok(metadata) = fs::metadata(absolute) else {
                continue;
            };
            if metadata.len() > MAX_SEARCH_FILE_BYTES {
                continue;
            }
            let Ok(bytes) = fs::read(absolute) else {
                continue;
            };
            if bytes.contains(&0) {
                continue;
            }
            let content = String::from_utf8_lossy(&bytes).to_lowercase();
            if content.contains(&query_lower) {
                add_result(&mut results, relative.clone(), "content");
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

fn main() -> ExitCode {
    let (command, options) = arguments();
    if command.as_deref() != Some("search-files") {
        eprintln!(
            "usage: umbratic-desktop-core search-files --root=<path> --query=<text> --limit=<count>"
        );
        return ExitCode::FAILURE;
    }
    let Some(root) = options.get("root").map(PathBuf::from) else {
        eprintln!("--root is required");
        return ExitCode::FAILURE;
    };
    let query = options.get("query").map(String::as_str).unwrap_or("");
    let limit = options
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(10)
        .clamp(1, 30);
    match search_files(&root, query, limit) {
        Ok(results) => match serde_json::to_string(&results) {
            Ok(json) => {
                println!("{json}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("Unable to serialize search results: {error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_matches_desktop_ordering() {
        let path = FileSearchResult {
            path: "src/runner.ts".into(),
            name: "runner.ts".into(),
            match_kind: "path",
        };
        let content = FileSearchResult {
            path: "src/other.ts".into(),
            name: "other.ts".into(),
            match_kind: "content",
        };
        assert!(score(&path, "runner") < score(&content, "runner"));
    }

    #[test]
    fn generated_and_secret_directories_are_ignored() {
        assert!(ignored_directory("node_modules"));
        assert!(blocked_path(".ssh/id_ed25519"));
        assert!(blocked_path("config/.env.local"));
        assert!(!blocked_path("src/main.rs"));
    }

    #[test]
    fn search_skips_binary_oversized_and_secret_content_and_honors_limits() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("first.txt"), "needle").unwrap();
        fs::write(directory.path().join("second.txt"), "needle").unwrap();
        fs::write(directory.path().join("binary.dat"), b"needle\0hidden").unwrap();
        fs::write(
            directory.path().join("large.txt"),
            vec![b'x'; MAX_SEARCH_FILE_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(directory.path().join(".env.local"), "needle=secret").unwrap();

        let results = search_files(directory.path(), "needle", 1).unwrap();
        assert_eq!(results.len(), 1);
        assert!(matches!(
            results[0].path.as_str(),
            "first.txt" | "second.txt"
        ));
        assert!(results.iter().all(|result| !matches!(
            result.path.as_str(),
            "binary.dat" | "large.txt" | ".env.local"
        )));
    }

    #[test]
    fn search_handles_non_utf8_files_and_rejects_non_directory_roots() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("mixed.bin"),
            b"prefix \xff needle suffix",
        )
        .unwrap();
        let results = search_files(directory.path(), "needle", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "mixed.bin");

        let file = directory.path().join("file.txt");
        fs::write(&file, "text").unwrap();
        assert_eq!(
            search_files(&file, "text", 10).unwrap_err(),
            "Search root must be a directory."
        );
    }
}
