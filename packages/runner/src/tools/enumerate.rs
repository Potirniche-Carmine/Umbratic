use std::io::{BufRead, BufReader};

use globset::{GlobBuilder, GlobSetBuilder};
use regex::RegexBuilder;
use serde_json::json;

use super::read::{list_entries, missing_path_message};
use super::*;

const MAX_GREP_LINE_BYTES: usize = 8 * 1024;

pub(super) async fn ls_tool(session: &Session, input: &Map<String, Value>) -> ToolExecutionResult {
    let path = string_arg(input, &["path"]);
    if path.is_empty() {
        return Err("ls requires string argument path".into());
    }
    let offset = input
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
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
    for entry in walker
        .follow_links(false)
        .into_iter()
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

pub(super) async fn grep_tool(
    session: &Session,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
    let pattern = string_arg(input, &["pattern"]);
    let mode = string_arg(input, &["mode"]);
    let (path, glob) = split_pattern_path(
        "grep",
        &string_arg(input, &["path"]),
        &string_arg(input, &["glob"]),
    )?;
    if pattern.is_empty() || path.is_empty() {
        return Err("grep requires string arguments pattern, mode, and path".into());
    }
    if pattern.contains('\0') || pattern.chars().count() > 512 {
        return Err("grep pattern exceeds the bounded string limits".into());
    }
    if mode != "literal" && mode != "regex" {
        return Err("grep mode must be literal or regex".into());
    }
    if !glob.is_empty() && (glob.contains('\0') || glob.chars().count() > 512) {
        return Err("grep glob exceeds the bounded string limits".into());
    }
    let case_sensitive = input
        .get("caseSensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let context = input
        .get("context")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(5) as usize;
    let limit = number_arg(input, "limit", 50) as usize;
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
        Err(error) => return Err(unusable_path_error("grep", &relative, &error)),
    };
    let regex = if mode == "regex" {
        Some(
            RegexBuilder::new(&pattern)
                .case_insensitive(!case_sensitive)
                .build()
                .map_err(|_| "grep regex is invalid".to_owned())?,
        )
    } else {
        None
    };
    let glob_matcher = if glob.is_empty() {
        None
    } else {
        Some(
            GlobBuilder::new(&glob)
                .case_insensitive(false)
                .literal_separator(true)
                .build()
                .and_then(|value| {
                    let mut set = GlobSetBuilder::new();
                    set.add(value);
                    set.build()
                })
                .map_err(|_| "grep glob is invalid".to_owned())?,
        )
    };
    let workspace_root = session
        .config
        .cwd
        .canonicalize()
        .unwrap_or_else(|_| session.config.cwd.clone());
    let mut files = Vec::new();
    if metadata.is_file() {
        files.push(absolute.clone());
    } else if metadata.is_dir() {
        for entry in WalkDir::new(&absolute)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let relative_workspace = entry
                .path()
                .strip_prefix(&workspace_root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            if should_skip(&relative_workspace) {
                continue;
            }
            if let Some(matcher) = &glob_matcher {
                let name = entry.file_name().to_string_lossy();
                if !matcher.is_match(&relative_workspace) && !matcher.is_match(name.as_ref()) {
                    continue;
                }
            }
            files.push(entry.path().to_path_buf());
        }
        files.sort();
    } else {
        return Err(ToolError::validation(
            "grep path must be a file or directory",
        ));
    }
    let mut rows = Vec::new();
    let mut match_count = 0usize;
    let mut truncated = false;
    let mut files_scanned = 0usize;
    for file in files {
        files_scanned += 1;
        let relative_workspace = file
            .strip_prefix(&workspace_root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let Ok(handle) = fs::File::open(&file) else {
            continue;
        };
        let reader = BufReader::new(handle);
        let mut lines = Vec::new();
        let mut binary = false;
        for line in reader.lines() {
            let Ok(line) = line else {
                binary = true;
                break;
            };
            if line.as_bytes().contains(&0) {
                binary = true;
                break;
            }
            if line.len() > MAX_GREP_LINE_BYTES {
                lines.push(clip_utf8(&line, MAX_GREP_LINE_BYTES));
            } else {
                lines.push(line);
            }
        }
        if binary {
            continue;
        }
        let mut matched_indexes = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            let matched = if let Some(regex) = &regex {
                regex.is_match(line)
            } else if case_sensitive {
                line.contains(&pattern)
            } else {
                line.to_ascii_lowercase()
                    .contains(&pattern.to_ascii_lowercase())
            };
            if matched {
                matched_indexes.push(index);
            }
        }
        for index in matched_indexes {
            match_count += 1;
            if rows.len() >= limit {
                truncated = true;
                continue;
            }
            let start = index.saturating_sub(context);
            let end = (index + context + 1).min(lines.len());
            for (line_index, line) in lines.iter().enumerate().take(end).skip(start) {
                let prefix = if line_index == index { ':' } else { '-' };
                rows.push(format!(
                    "{relative_workspace}:{}{prefix} {line}",
                    line_index + 1
                ));
            }
        }
    }
    let content = if rows.is_empty() {
        "No matches.".to_owned()
    } else {
        rows.join("\n")
    };
    Ok(ToolResult::success_detailed(
        format!("grep {pattern}"),
        content,
        Some(json!({
            "path": if relative.is_empty() { "." } else { &relative },
            "mode": mode,
            "matchCount": match_count,
            "filesScanned": files_scanned,
            "truncated": truncated,
        })),
        None,
    ))
}

fn clip_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}
