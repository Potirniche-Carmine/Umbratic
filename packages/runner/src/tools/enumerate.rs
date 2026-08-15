use globset::{GlobBuilder, GlobSetBuilder};
use serde_json::json;

use super::read::{list_entries, missing_path_message};
use super::*;

pub(super) async fn ls_tool(session: &Session, input: &Map<String, Value>) -> ToolExecutionResult {
    let path = string_arg(input, &["path"]);
    if path.is_empty() {
        return Err("ls requires string argument path".into());
    }
    // The catalog declares offset as one-based and rejects 0 before dispatch.
    let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(1) as usize;
    let limit = number_arg(input, "limit", 100) as usize;
    glob_free_path("ls", &path)?;
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &path).map_err(ToolError::policy)?;
    let metadata = match fs::metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ToolError::validation(missing_path_message(
                &session.config.cwd,
                &absolute,
                &relative,
            )));
        }
        Err(error) => return Err(unusable_path_error("ls", &relative, &error)),
    };
    if !metadata.is_dir() {
        return Err(ToolError::validation(
            "ls accepts one directory. Use read for a file.",
        ));
    }
    let workspace_root = session
        .config
        .cwd
        .canonicalize()
        .unwrap_or_else(|_| session.config.cwd.clone());
    let entries = list_entries(&absolute)
        .into_iter()
        .filter(|entry| {
            let trimmed = entry.trim_end_matches('/');
            let relative_workspace = absolute
                .join(trimmed)
                .strip_prefix(&workspace_root)
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| {
                    if relative.is_empty() {
                        trimmed.to_owned()
                    } else {
                        format!("{relative}/{trimmed}")
                    }
                });
            !should_skip(&relative_workspace)
        })
        .collect::<Vec<_>>();
    let start = offset.saturating_sub(1).min(entries.len());
    let end = (start + limit).min(entries.len());
    let selected = &entries[start..end];
    let next_offset = if end < entries.len() {
        Some(end + 1)
    } else {
        None
    };
    let content = if selected.is_empty() {
        "(empty directory)".to_owned()
    } else {
        selected.join("\n")
    };
    Ok(ToolResult::success_detailed(
        if relative.is_empty() {
            ".".into()
        } else {
            relative.clone()
        },
        content,
        Some(json!({
            "path": if relative.is_empty() { "." } else { &relative },
            "shownStart": if entries.is_empty() { 0 } else { start + 1 },
            "shownEnd": end,
            "totalEntries": entries.len(),
        })),
        next_offset.map(|value| json!({ "nextOffset": value })),
    ))
}

pub(super) async fn find_tool(
    session: &Session,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let (path, glob) = split_pattern_path(
        "find",
        &string_arg(input, &["path"]),
        &string_arg(input, &["glob"]),
    )?;
    if path.is_empty() || glob.is_empty() {
        return Err("find requires string arguments path and glob".into());
    }
    if glob.contains('\0') || glob.chars().count() > 512 {
        return Err("find glob exceeds the bounded string limits".into());
    }
    let limit = number_arg(input, "limit", 100) as usize;
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &path).map_err(ToolError::policy)?;
    let metadata = match fs::metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ToolError::validation(missing_path_message(
                &session.config.cwd,
                &absolute,
                &relative,
            )));
        }
        Err(error) => return Err(unusable_path_error("find", &relative, &error)),
    };
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(ToolError::validation(
            "find path must be a file or directory",
        ));
    }
    let matcher = GlobBuilder::new(&glob)
        .case_insensitive(false)
        .literal_separator(true)
        .build()
        .and_then(|value| {
            let mut set = GlobSetBuilder::new();
            set.add(value);
            set.build()
        })
        .map_err(|_| "find glob is invalid".to_owned())?;
    let workspace_root = session
        .config
        .cwd
        .canonicalize()
        .unwrap_or_else(|_| session.config.cwd.clone());
    let mut matches = BTreeSet::new();
    let walker = if metadata.is_file() {
        WalkDir::new(&absolute).max_depth(0)
    } else {
        WalkDir::new(&absolute).min_depth(1)
    };
    // Same prune search uses: skip the entry and do not descend. Filtering
    // after the walk still visits every file under `.llama-cache` and `target`.
    for entry in walker
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().is_symlink() {
                return false;
            }
            let relative_workspace = entry
                .path()
                .strip_prefix(&workspace_root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            !should_skip(&relative_workspace)
        })
        .filter_map(Result::ok)
    {
        let relative_workspace = entry
            .path()
            .strip_prefix(&workspace_root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if should_skip(&relative_workspace) {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        let matched = matcher.is_match(&relative_workspace) || matcher.is_match(name.as_ref());
        if !matched {
            continue;
        }
        matches.insert(relative_workspace);
    }
    let total = matches.len();
    let selected = matches.into_iter().take(limit).collect::<Vec<_>>();
    let truncated = total > selected.len();
    let content = if selected.is_empty() {
        "No matching paths.".to_owned()
    } else {
        selected.join("\n")
    };
    Ok(ToolResult::success_detailed(
        format!("find {glob}"),
        content,
        Some(json!({
            "path": if relative.is_empty() { "." } else { &relative },
            "glob": glob,
            "resultCount": selected.len(),
            "totalMatches": total,
            "truncated": truncated,
        })),
        None,
    ))
}
