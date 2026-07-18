use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

use globset::GlobBuilder;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::{Duration, Instant as TokioInstant, interval, sleep_until},
};
use walkdir::WalkDir;

use crate::{
    config::PermissionMode,
    context::compress_tool_result,
    events::now_iso,
    policy::{
        classify_command_text, is_blocked_path, is_generated_runtime_path, redact_stream_text,
        redact_text, resolve_workspace_path,
    },
    session::{EventSink, Session},
};

const MAX_READ_OUTPUT_BYTES: usize = 60 * 1024;
const MAX_TEXT_FILE_BYTES: u64 = 512 * 1024;
static RECENT_READS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
type PatchTransaction = (HashMap<PathBuf, Option<String>>, Vec<String>);

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub index: usize,
}

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub title: String,
    pub output: String,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub exit_code: Option<i32>,
    pub details: Option<Value>,
}

impl ToolResult {
    fn success(title: impl Into<String>, output: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            output: output.into(),
            status: "success".into(),
            error_code: None,
            error_message: None,
            exit_code: Some(0),
            details: None,
        }
    }
    fn failure(status: &str, code: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            title: "tool".into(),
            output: redact_text(&format!("Tool failed: {message}"), 600),
            status: status.into(),
            error_code: Some(code.into()),
            error_message: Some(message),
            exit_code: Some(1),
            details: None,
        }
    }
}

fn parse_arguments(value: &Value) -> Result<Map<String, Value>, String> {
    if let Some(object) = value.as_object() {
        return Ok(object.clone());
    }
    let Some(mut text) = value.as_str().map(str::trim) else {
        return Err("Tool arguments must be a JSON object.".into());
    };
    if text.starts_with("```") && text.ends_with("```") {
        text = text
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
    }
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| "Tool arguments must be valid JSON object.".into())
}

fn string_arg(input: &Map<String, Value>, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| input.get(*name).and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}

fn number_arg(input: &Map<String, Value>, name: &str, fallback: u64, max: u64) -> u64 {
    input
        .get(name)
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
        .clamp(1, max)
}

fn validate_arguments(name: &str, input: &Map<String, Value>) -> Result<(), String> {
    let allowed: &[&str] = match name {
        "read" => &["filePath", "path", "offset", "limit", "depth"],
        "write" => &["filePath", "path", "content"],
        "edit" => &[
            "mode",
            "filePath",
            "path",
            "oldText",
            "old_string",
            "newText",
            "new_string",
            "patch",
        ],
        "search" => &["query", "limit"],
        "workspace_graph" => &[
            "action",
            "query",
            "symbol",
            "from",
            "to",
            "files",
            "symbols",
            "depth",
            "limit",
            "maxDepth",
            "direction",
        ],
        "command" => &["command", "timeoutMs"],
        "read_skill" => &["skillId", "resource", "offset", "limit"],
        "retrieve_context" => &["hash", "offset", "limit"],
        _ => return Ok(()),
    };
    if let Some(key) = input.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{name} received unknown argument {key}"));
    }
    for key in ["offset", "limit", "depth", "maxDepth", "timeoutMs"] {
        if input.contains_key(key) && !input.get(key).is_some_and(Value::is_number) {
            return Err(format!("{name} argument {key} must be a number"));
        }
    }
    let required = match name {
        "read" => vec![string_arg(input, &["filePath", "path"])],
        "write" => vec![string_arg(input, &["filePath", "path"])],
        "search" => vec![string_arg(input, &["query"])],
        "command" => vec![string_arg(input, &["command"])],
        "read_skill" => vec![string_arg(input, &["skillId"])],
        "retrieve_context" => vec![string_arg(input, &["hash"])],
        "workspace_graph" => vec![string_arg(input, &["action"])],
        "edit"
            if input.get("mode").and_then(Value::as_str) == Some("patch")
                || (input.contains_key("patch") && !input.contains_key("filePath")) =>
        {
            vec![string_arg(input, &["patch"])]
        }
        "edit" => vec![
            string_arg(input, &["filePath", "path"]),
            string_arg(input, &["oldText", "old_string"]),
        ],
        _ => vec![],
    };
    if required.iter().any(|value| value.is_empty()) {
        return Err(format!("{name} is missing a required string argument"));
    }
    if name == "write" && !input.get("content").is_some_and(Value::is_string) {
        return Err("write argument content must be a string".into());
    }
    if name == "edit" {
        let mode = input
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("replace");
        if !matches!(mode, "replace" | "patch") {
            return Err("edit mode must be replace or patch".into());
        }
        if mode == "replace"
            && !(input
                .get("newText")
                .or_else(|| input.get("new_string"))
                .is_some_and(Value::is_string))
        {
            return Err("edit newText must be a string".into());
        }
    }
    Ok(())
}

fn ensure_text_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Path is not a file".into());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err("File is too large to read through this tool".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.contains(&0) {
        return Err("Refusing to read binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "Refusing to read non-UTF-8 file".into())
}

fn clip_read_output(output: String) -> String {
    if output.len() <= MAX_READ_OUTPUT_BYTES {
        return output;
    }
    let mut end = MAX_READ_OUTPUT_BYTES;
    while !output.is_char_boundary(end) {
        end -= 1
    }
    format!(
        "{}\n...[truncated: read output exceeded {MAX_READ_OUTPUT_BYTES} bytes; use offset/limit to continue]",
        &output[..end]
    )
}

fn should_skip(relative: &str) -> bool {
    relative.is_empty() || is_generated_runtime_path(relative) || is_blocked_path(relative)
}

fn list_directory(cwd: &Path, directory: &Path, depth: usize) -> Vec<String> {
    let mut rows = BTreeSet::new();
    for entry in WalkDir::new(directory)
        .min_depth(1)
        .max_depth(depth)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let relative_workspace = entry
            .path()
            .strip_prefix(cwd)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        if should_skip(&relative_workspace) {
            continue;
        }
        let display = entry
            .path()
            .strip_prefix(directory)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        rows.insert(format!(
            "{display}{}",
            if entry.file_type().is_dir() { "/" } else { "" }
        ));
    }
    rows.into_iter().collect()
}

async fn read_tool(session: &Session, input: &Map<String, Value>) -> Result<ToolResult, String> {
    let mut file_path = string_arg(input, &["filePath", "path"]);
    if file_path.is_empty() {
        return Err("read requires string argument filePath".into());
    }
    let explicit_offset = input
        .get("offset")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0);
    let mut offset = explicit_offset.unwrap_or(1) as usize;
    if explicit_offset.is_none()
        && let Some((path, line)) = file_path
            .rsplit_once(':')
            .and_then(|(path, suffix)| suffix.parse::<usize>().ok().map(|line| (path, line)))
        && resolve_workspace_path(&session.config.cwd, path)
            .ok()
            .is_some_and(|(target, _)| target.is_file())
    {
        file_path = path.to_owned();
        offset = line.saturating_sub(5).max(1);
    }
    let limit = number_arg(input, "limit", 500, 500) as usize;
    let depth = number_arg(input, "depth", 1, 6) as usize;
    let (absolute, relative) = resolve_workspace_path(&session.config.cwd, &file_path)?;
    let metadata = fs::metadata(&absolute).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        let entries = list_directory(&session.config.cwd, &absolute, depth);
        let start = offset.saturating_sub(1).min(entries.len());
        let selected = &entries[start..(start + limit).min(entries.len())];
        let next = start + selected.len();
        let status = if next < entries.len() {
            format!("partial; continue with offset {}", next + 1)
        } else {
            "complete".into()
        };
        let output = format!(
            "Directory: {}\nDepth: {depth}\nEntries shown: {}-{} of {}\nListing status: {status}\nEntries:\n{}",
            if relative.is_empty() { "." } else { &relative },
            if entries.is_empty() { 0 } else { start + 1 },
            next,
            entries.len(),
            if selected.is_empty() {
                "(empty directory)".into()
            } else {
                selected.join("\n")
            }
        );
        return Ok(ToolResult::success(
            if relative.is_empty() { "." } else { &relative },
            clip_read_output(output),
        ));
    }
    let content = ensure_text_file(&absolute)?.replace("\r\n", "\n");
    let mut reads = RECENT_READS.get_or_init(Default::default).lock().unwrap();
    *reads.entry(absolute.clone()).or_default() += 1;
    drop(reads);
    let output = content
        .split('\n')
        .skip(offset.saturating_sub(1))
        .take(limit)
        .enumerate()
        .map(|(index, line)| format!("{}: {line}", offset + index))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ToolResult::success(relative, clip_read_output(output)))
}

async fn write_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
) -> Result<ToolResult, String> {
    let path = string_arg(input, &["filePath", "path"]);
    let content = input
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "write requires string argument content".to_owned())?;
    let (absolute, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
    let decision = permissions
        .request(
            sink,
            &session.task_id,
            "edit",
            &format!("write {relative}"),
            session.config.permission_mode == PermissionMode::Bypass,
        )
        .await;
    if decision != "allow" {
        return Err(format!("Write denied: {relative}"));
    }
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&absolute, content).map_err(|error| error.to_string())?;
    Ok(ToolResult::success(
        relative.clone(),
        "Wrote file successfully.",
    ))
}

#[derive(Debug)]
enum PatchOperation {
    Add(String, Vec<String>),
    Delete(String),
    Update(String, Option<String>, Vec<Vec<(char, String)>>),
}

fn parse_patch(patch: &str) -> Result<Vec<PatchOperation>, String> {
    let normalized = patch.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<_> = normalized.lines().collect();
    if lines.first() != Some(&"*** Begin Patch") {
        return Err("Patch must start with *** Begin Patch".into());
    }
    if lines.last() != Some(&"*** End Patch") {
        return Err("Patch must end with *** End Patch".into());
    }
    lines.remove(0);
    lines.pop();
    let mut operations = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            index += 1;
            let mut body = Vec::new();
            while index < lines.len() && !lines[index].starts_with("*** ") {
                let Some(value) = lines[index].strip_prefix('+') else {
                    return Err(format!("Add File lines must start with + in {path}"));
                };
                body.push(value.to_owned());
                index += 1;
            }
            if body.is_empty() {
                return Err(format!("Add File requires at least one + line: {path}"));
            }
            operations.push(PatchOperation::Add(path.trim().into(), body));
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            operations.push(PatchOperation::Delete(path.trim().into()));
            index += 1;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            index += 1;
            let mut move_to = None;
            if index < lines.len()
                && let Some(target) = lines[index].strip_prefix("*** Move to: ")
            {
                move_to = Some(target.trim().into());
                index += 1;
            }
            let mut hunks = Vec::new();
            let mut current = Vec::new();
            while index < lines.len()
                && !lines[index].starts_with("*** Add File: ")
                && !lines[index].starts_with("*** Delete File: ")
                && !lines[index].starts_with("*** Update File: ")
            {
                let value = lines[index];
                if value == "@@" || value.starts_with("@@ ") || value == "*** End of File" {
                    if !current.is_empty() {
                        hunks.push(std::mem::take(&mut current));
                    }
                    index += 1;
                    continue;
                }
                let marker = value
                    .chars()
                    .next()
                    .ok_or_else(|| "Invalid empty patch line".to_owned())?;
                if !matches!(marker, ' ' | '+' | '-') {
                    return Err(format!("Invalid patch line in {path}: {value}"));
                }
                current.push((marker, value[marker.len_utf8()..].to_owned()));
                index += 1;
            }
            if !current.is_empty() {
                hunks.push(current);
            }
            operations.push(PatchOperation::Update(path.trim().into(), move_to, hunks));
            continue;
        }
        return Err(format!("Unexpected patch line: {line}"));
    }
    if operations.is_empty() {
        return Err("Patch must contain at least one file operation".into());
    }
    Ok(operations)
}

fn apply_patch(session: &Session, patch: &str) -> Result<PatchTransaction, String> {
    let mut virtual_files: HashMap<PathBuf, Option<String>> = HashMap::new();
    let mut summaries = Vec::new();
    for operation in parse_patch(patch)? {
        match operation {
            PatchOperation::Add(path, lines) => {
                let (target, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
                if virtual_files
                    .get(&target)
                    .and_then(Option::as_ref)
                    .is_some()
                    || target.exists()
                {
                    return Err(format!("Patch target already exists: {relative}"));
                }
                virtual_files.insert(target, Some(lines.join("\n")));
                summaries.push(format!("added {relative}"));
            }
            PatchOperation::Delete(path) => {
                let (target, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
                if !target.exists() && !virtual_files.contains_key(&target) {
                    return Err(format!("Patch delete target was not found: {relative}"));
                }
                virtual_files.insert(target, None);
                summaries.push(format!("deleted {relative}"));
            }
            PatchOperation::Update(path, move_to, hunks) => {
                let (target, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
                let mut content = match virtual_files.get(&target) {
                    Some(Some(value)) => value.clone(),
                    Some(None) => {
                        return Err(format!("Patch update target was not found: {relative}"));
                    }
                    None => ensure_text_file(&target)?,
                };
                for hunk in hunks {
                    let old = hunk
                        .iter()
                        .filter(|(kind, _)| *kind != '+')
                        .map(|(_, line)| line.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    let new = hunk
                        .iter()
                        .filter(|(kind, _)| *kind != '-')
                        .map(|(_, line)| line.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    if old == new {
                        continue;
                    }
                    if old.is_empty() || !content.contains(&old) {
                        return Err(format!("Patch hunk was not found in {relative}"));
                    }
                    content = content.replacen(&old, &new, 1);
                }
                if let Some(destination) = move_to {
                    let (moved, moved_relative) =
                        resolve_workspace_path(&session.config.cwd, &destination)?;
                    if moved != target && (moved.exists() || virtual_files.contains_key(&moved)) {
                        return Err(format!("Patch target already exists: {moved_relative}"));
                    }
                    virtual_files.insert(target, None);
                    virtual_files.insert(moved, Some(content));
                    summaries.push(format!("renamed {relative} -> {moved_relative}"));
                } else {
                    virtual_files.insert(target, Some(content));
                    summaries.push(format!("modified {relative}"));
                }
            }
        }
    }
    Ok((virtual_files, summaries))
}

async fn edit_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
) -> Result<ToolResult, String> {
    let patch_mode = input.get("mode").and_then(Value::as_str) == Some("patch")
        || (input.contains_key("patch") && !input.contains_key("filePath"));
    if patch_mode {
        let patch = input
            .get("patch")
            .and_then(Value::as_str)
            .ok_or_else(|| "edit patch mode requires patch content".to_owned())?;
        let (files, summaries) = apply_patch(session, patch)?;
        let decision = permissions
            .request(
                sink,
                &session.task_id,
                "edit",
                &format!(
                    "patch {} file{}: {}",
                    summaries.len(),
                    if summaries.len() == 1 { "" } else { "s" },
                    summaries
                        .iter()
                        .take(4)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                session.config.permission_mode == PermissionMode::Bypass,
            )
            .await;
        if decision != "allow" {
            return Err("Patch edit denied".into());
        }
        for (path, content) in files {
            if let Some(content) = content {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(path, content).map_err(|error| error.to_string())?;
            } else if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        return Ok(ToolResult::success(
            "patch",
            format!(
                "Patched {} file{} successfully.\n- {}",
                summaries.len(),
                if summaries.len() == 1 { "" } else { "s" },
                summaries.join("\n- ")
            ),
        ));
    }
    let path = string_arg(input, &["filePath", "path"]);
    let old = string_arg(input, &["oldText", "old_string"]);
    let new = string_arg(input, &["newText", "new_string"]);
    if old.is_empty() {
        return Err("edit replace mode requires oldText".into());
    }
    if old == new {
        return Err("edit replacement must change the file".into());
    }
    let (absolute, relative) = resolve_workspace_path(&session.config.cwd, &path)?;
    let current = ensure_text_file(&absolute)?;
    if !current.contains(&old) {
        return Err(format!("Text to replace was not found in {relative}"));
    }
    let decision = permissions
        .request(
            sink,
            &session.task_id,
            "edit",
            &format!("edit {relative}"),
            session.config.permission_mode == PermissionMode::Bypass,
        )
        .await;
    if decision != "allow" {
        return Err(format!("Edit denied: {relative}"));
    }
    fs::write(absolute, current.replacen(&old, &new, 1)).map_err(|error| error.to_string())?;
    Ok(ToolResult::success(relative, "Edited file successfully."))
}

#[derive(Default)]
struct SearchQuery {
    terms: Vec<String>,
    include_dirs: Vec<String>,
    include_globs: Vec<String>,
    exclude_dirs: Vec<String>,
    exclude_globs: Vec<String>,
    location: Option<String>,
    smart_case: bool,
}

fn parse_search_query(raw: &str) -> SearchQuery {
    let mut query = SearchQuery {
        smart_case: raw.chars().any(char::is_uppercase),
        ..Default::default()
    };
    for token in raw.split_whitespace() {
        let excluded = token.starts_with('!') && token.len() > 1;
        let value = token
            .trim_start_matches('!')
            .trim_start_matches("./")
            .replace('\\', "/");
        if !excluded
            && let Some((path, suffix)) = value.rsplit_once(':')
            && suffix.parse::<u64>().is_ok()
            && !path.is_empty()
        {
            query.location = path
                .rsplit_once(':')
                .filter(|(_, line)| line.parse::<u64>().is_ok())
                .map_or_else(|| Some(path.to_owned()), |(path, _)| Some(path.to_owned()));
            continue;
        }
        if value.ends_with('/') {
            if excluded {
                query.exclude_dirs.push(value);
            } else {
                query.include_dirs.push(value);
            }
        } else if value
            .chars()
            .any(|value| matches!(value, '*' | '?' | '[' | ']'))
        {
            if excluded {
                query.exclude_globs.push(value);
            } else {
                query.include_globs.push(value);
            }
        } else if excluded {
            query.exclude_globs.push(value);
        } else if !value.is_empty() {
            query.terms.push(value);
        }
    }
    query
}

fn glob_matches(pattern: &str, relative: &str, filename: &str, case_sensitive: bool) -> bool {
    let target = if pattern.contains('/') {
        relative
    } else {
        filename
    };
    GlobBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .literal_separator(true)
        .build()
        .is_ok_and(|glob| glob.compile_matcher().is_match(target))
}

fn search_constraints(relative: &str, filename: &str, query: &SearchQuery) -> bool {
    let candidate = if query.smart_case {
        relative.to_owned()
    } else {
        relative.to_lowercase()
    };
    let normalize = |value: &str| {
        if query.smart_case {
            value.to_owned()
        } else {
            value.to_lowercase()
        }
    };
    query
        .include_dirs
        .iter()
        .all(|value| candidate.starts_with(&normalize(value)))
        && query
            .include_globs
            .iter()
            .all(|value| glob_matches(value, relative, filename, query.smart_case))
        && !query.exclude_dirs.iter().any(|value| {
            let value = normalize(value);
            candidate.starts_with(&value) || candidate.contains(&format!("/{value}"))
        })
        && !query
            .exclude_globs
            .iter()
            .any(|value| glob_matches(value, relative, filename, query.smart_case))
}

fn fuzzy_score(candidate: &str, query: &str, filename: bool) -> f64 {
    if query.is_empty() {
        return 0.0;
    }
    let chars = candidate.chars().collect::<Vec<_>>();
    let mut last = None;
    let mut first = 0usize;
    let mut run = 0usize;
    let mut score = if filename { 120.0 } else { 70.0 };
    for query_char in query.chars() {
        let start = last.map_or(0, |value| value + 1);
        let Some(next) = chars
            .iter()
            .enumerate()
            .skip(start)
            .find_map(|(index, value)| (*value == query_char).then_some(index))
        else {
            return 0.0;
        };
        if last.is_none() {
            first = next;
        }
        if last.is_some_and(|value| next == value + 1) {
            run += 1;
            score += 12.0 + run.min(5) as f64 * 3.0;
        } else {
            run = 1;
            score += 5.0;
        }
        if next == 0
            || chars
                .get(next.saturating_sub(1))
                .is_some_and(|value| "/._-".contains(*value))
        {
            score += if filename { 12.0 } else { 6.0 };
        }
        last = Some(next);
    }
    let last = last.unwrap_or(first);
    let query_len = query.chars().count();
    let span = last - first + 1;
    score += query_len as f64 * if filename { 10.0 } else { 6.0 };
    score -= span.saturating_sub(query_len) as f64 * 2.0;
    score -= first as f64 * 0.5;
    score.max(1.0)
}

fn term_score(relative: &str, filename: &str, term: &str, case_sensitive: bool) -> f64 {
    let convert = |value: &str| {
        if case_sensitive {
            value.to_owned()
        } else {
            value.to_lowercase()
        }
    };
    let query = convert(term);
    let name = convert(filename);
    let path = convert(relative);
    let mut score: f64 = 0.0;
    if name == query {
        score = score.max(600.0);
    }
    if path == query {
        score = score.max(580.0);
    }
    if path.ends_with(&query) {
        score = score.max(360.0);
    }
    if let Some(index) = name.find(&query) {
        score = score.max(320.0 - index.min(80) as f64);
    }
    if let Some(index) = path.find(&query) {
        score = score.max(180.0 - index.min(80) as f64);
    }
    score
        .max(fuzzy_score(&name, &query, true))
        .max(fuzzy_score(&path, &query, false))
}

async fn search_tool(session: &Session, input: &Map<String, Value>) -> Result<ToolResult, String> {
    let query = string_arg(input, &["query"]);
    if query.trim().is_empty() {
        return Err("search requires query".into());
    }
    let limit = number_arg(input, "limit", 50, 100) as usize;
    let parsed = parse_search_query(&query);
    let path_terms = if parsed.terms.is_empty() {
        parsed.location.iter().cloned().collect::<Vec<_>>()
    } else {
        parsed.terms.clone()
    };
    let recent = RECENT_READS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .clone();
    let mut path_hits: Vec<(String, f64)> = Vec::new();
    let mut content_hits: Vec<(String, usize, u8, f64)> = Vec::new();
    let definition_pattern = Regex::new(
        r"^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|fn|def|impl|trait)\b",
    )
    .expect("definition ranking regex is valid");
    let import_pattern = Regex::new(r"^(?:import\b|from\b|require\s*\(|use\b|#include\b)")
        .expect("import ranking regex is valid");
    for entry in WalkDir::new(&session.config.cwd)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let relative = entry
                .path()
                .strip_prefix(&session.config.cwd)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            let candidate = if entry.file_type().is_dir() {
                format!("{relative}/")
            } else {
                relative.clone()
            };
            relative.is_empty() || !should_skip(&candidate)
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&session.config.cwd)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        let filename = entry.file_name().to_string_lossy();
        if !search_constraints(&relative, &filename, &parsed) {
            continue;
        }
        let has_path_intent = !path_terms.is_empty()
            || !parsed.include_dirs.is_empty()
            || !parsed.include_globs.is_empty()
            || parsed.location.is_some();
        let base = if path_terms.is_empty() {
            10.0
        } else {
            path_terms
                .iter()
                .try_fold(0.0, |total, term| {
                    let score = term_score(&relative, &filename, term, parsed.smart_case);
                    (score > 0.0).then_some(total + score)
                })
                .unwrap_or(0.0)
        };
        let canonical = entry
            .path()
            .canonicalize()
            .unwrap_or_else(|_| entry.path().to_owned());
        let boost = recent.get(&canonical).copied().unwrap_or(0) as f64 * 35.0;
        if has_path_intent && base > 0.0 {
            path_hits.push((relative.clone(), base + boost));
        }
        if entry
            .metadata()
            .is_ok_and(|metadata| metadata.len() <= MAX_TEXT_FILE_BYTES)
            && let Ok(content) = ensure_text_file(entry.path())
        {
            for (index, line) in content.lines().enumerate() {
                let candidate = if parsed.smart_case {
                    line.to_owned()
                } else {
                    line.to_lowercase()
                };
                if !parsed.terms.is_empty()
                    && parsed.terms.iter().all(|term| {
                        candidate.contains(&if parsed.smart_case {
                            term.clone()
                        } else {
                            term.to_lowercase()
                        })
                    })
                {
                    let trimmed = line.trim_start();
                    let rank = if definition_pattern.is_match(trimmed) {
                        0
                    } else if import_pattern.is_match(trimmed) {
                        2
                    } else {
                        1
                    };
                    content_hits.push((relative.clone(), index + 1, rank, boost));
                }
            }
        }
    }
    path_hits.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then(left.0.len().cmp(&right.0.len()))
            .then(left.0.cmp(&right.0))
    });
    content_hits.sort_by(|left, right| {
        left.2
            .cmp(&right.2)
            .then(right.3.total_cmp(&left.3))
            .then(left.0.cmp(&right.0))
            .then(left.1.cmp(&right.1))
    });
    let mut results = path_hits
        .into_iter()
        .map(|(path, _)| format!("{path}: path"))
        .collect::<Vec<_>>();
    results.extend(
        content_hits
            .into_iter()
            .map(|(path, line, _, _)| format!("{path}:{line}: content")),
    );
    results.truncate(limit);
    Ok(ToolResult::success(
        format!("search {query}"),
        if results.is_empty() {
            "No matches.".into()
        } else {
            results.join("\n")
        },
    ))
}

async fn command_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
    call_id: &str,
) -> Result<ToolResult, String> {
    let command = string_arg(input, &["command"]).trim().to_owned();
    if command.is_empty() {
        return Err("command requires command".into());
    }
    let classification = classify_command_text(&command, Some(&session.config.cwd));
    if matches!(
        classification.command_class,
        "network" | "external-directory"
    ) {
        return Err(format!(
            "Command blocked by policy: {}",
            classification
                .reason
                .unwrap_or(classification.command_class)
        ));
    }
    let auto_allow =
        session.config.permission_mode == PermissionMode::Bypass && !classification.risky;
    let decision = permissions
        .request(
            sink,
            &session.task_id,
            "bash",
            &redact_text(&command, 320),
            auto_allow,
        )
        .await;
    if decision != "allow" {
        return Err("Command denied.".into());
    }
    let requested = input
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10 * 60 * 1000)
        .clamp(100, 30 * 60 * 1000);
    let mut process = if cfg!(windows) {
        let mut value = Command::new("powershell.exe");
        value.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &command,
        ]);
        value
    } else {
        let mut value = Command::new("/bin/sh");
        value.args(["-c", &command]);
        value
    };
    process
        .current_dir(&session.config.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.as_std_mut().process_group(0);
    }
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to capture command stdout".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Unable to capture command stderr".to_owned())?;
    async fn collect_stream<R: AsyncRead + Unpin>(
        mut reader: R,
        sink: EventSink,
        task_id: String,
        call_id: String,
        stream: &'static str,
    ) -> String {
        let mut collected = String::new();
        let mut buffer = vec![0u8; 8192];
        while let Ok(count) = reader.read(&mut buffer).await {
            if count == 0 {
                break;
            }
            let text = redact_stream_text(&String::from_utf8_lossy(&buffer[..count]), 64 * 1024);
            if collected.len() < 64 * 1024 {
                let mut end = text.len().min(64 * 1024 - collected.len());
                while end > 0 && !text.is_char_boundary(end) {
                    end -= 1;
                }
                collected.push_str(&text[..end]);
            }
            if !text.is_empty() {
                sink.emit(json!({ "type":"tool.output", "taskId":task_id, "toolCallId":call_id, "stream":stream, "text":text, "redacted":true, "at":now_iso() }));
            }
        }
        collected
    }
    let stdout_task = tokio::spawn(collect_stream(
        stdout,
        sink.clone(),
        session.task_id.clone(),
        call_id.to_owned(),
        "stdout",
    ));
    let stderr_task = tokio::spawn(collect_stream(
        stderr,
        sink.clone(),
        session.task_id.clone(),
        call_id.to_owned(),
        "stderr",
    ));
    let deadline = TokioInstant::now() + Duration::from_millis(requested);
    let mut abort_poll = interval(Duration::from_millis(25));
    let mut timed_out = false;
    let mut aborted = false;
    let status = loop {
        tokio::select! {
            result = child.wait() => break result.map_err(|error| error.to_string())?,
            _ = sleep_until(deadline) => { timed_out = true; terminate_command_tree(&mut child, pid).await; break child.wait().await.map_err(|error| error.to_string())?; },
            _ = abort_poll.tick() => if session.is_aborted() { aborted = true; terminate_command_tree(&mut child, pid).await; break child.wait().await.map_err(|error| error.to_string())?; }
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    let exit = status.code();
    let success = status.success() && !timed_out && !aborted;
    let body = [
        format!(
            "exitCode={}",
            exit.map_or_else(|| "unknown".into(), |value| value.to_string())
        ),
        stdout.trim().to_owned(),
        stderr.trim().to_owned(),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    Ok(ToolResult {
        title: redact_text(&command, 320),
        output: body,
        status: if aborted {
            "aborted"
        } else if timed_out {
            "timeout"
        } else if success {
            "success"
        } else {
            "runtime_error"
        }
        .into(),
        error_code: if aborted {
            Some("aborted".into())
        } else if timed_out {
            Some("process_timeout".into())
        } else if success {
            None
        } else {
            Some("command_exit_nonzero".into())
        },
        error_message: if aborted {
            Some("Command was aborted.".into())
        } else if timed_out {
            Some(format!("Command timed out after {requested} ms."))
        } else if success {
            None
        } else {
            Some(format!(
                "Command exited with code {}.",
                exit.map_or_else(|| "unknown".into(), |value| value.to_string())
            ))
        },
        exit_code: exit,
        details: None,
    })
}

async fn terminate_command_tree(child: &mut tokio::process::Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // The shell is launched as its own process group, matching the previous runner's tree termination semantics.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        return;
    }
    #[cfg(not(unix))]
    let _ = pid;
    let _ = child.kill().await;
}

fn read_skill_tool(session: &Session, input: &Map<String, Value>) -> Result<ToolResult, String> {
    let skill_id = string_arg(input, &["skillId"]);
    let skill = session
        .config
        .skills
        .iter()
        .find(|skill| skill.id == skill_id)
        .ok_or_else(|| format!("Skill {skill_id} is not enabled."))?;
    let resource = input
        .get("resource")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let primary = skill
        .instruction_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let target = match resource {
        None | Some("SKILL.md") => primary.clone(),
        Some(raw) => {
            if primary
                .file_name()
                .and_then(|value| value.to_str())
                .is_none_or(|value| !value.eq_ignore_ascii_case("SKILL.md"))
            {
                return Err("This standalone skill has no readable resource folder.".into());
            }
            if Path::new(raw).is_absolute() {
                return Err("Skill resources must use a relative path.".into());
            }
            let root = primary.parent().unwrap();
            let joined = root.join(raw);
            let existing = joined
                .canonicalize()
                .map_err(|_| format!("Skill resource not found: {raw}"))?;
            if !existing.starts_with(root) {
                return Err("Refusing skill resource outside its skill folder.".into());
            }
            if is_blocked_path(raw) {
                return Err(format!("Refusing blocked skill resource: {raw}"));
            }
            existing
        }
    };
    let content = ensure_text_file(&target)?;
    let offset = input
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(content.len() as u64) as usize;
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(6 * 1024)
        .clamp(1, 8 * 1024) as usize;
    let mut start = offset;
    while start < content.len() && !content.is_char_boundary(start) {
        start += 1
    }
    let mut end = (start + limit).min(content.len());
    while end > start && !content.is_char_boundary(end) {
        end -= 1
    }
    let label = resource.unwrap_or_else(|| {
        target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("SKILL.md")
    });
    Ok(ToolResult::success(
        if resource.is_some() {
            format!("{skill_id}/{label}")
        } else {
            skill_id.clone()
        },
        format!(
            "Skill: {} ({})\nResource: {label}\nBytes: {start}-{end} of {}\n{}\n\n{}",
            skill.id,
            skill.name,
            content.len(),
            if end < content.len() {
                format!("Next offset: {end}")
            } else {
                "Read status: complete".into()
            },
            &content[start..end]
        ),
    ))
}

fn tool_definition(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description, "parameters": { "type": "object", "properties": properties, "required": required } } })
}

pub async fn enabled_tool_specs(session: &Session, include_tools: bool) -> Vec<Value> {
    if !include_tools {
        return Vec::new();
    }
    let enabled = &session.config.enabled_tools;
    let mut specs = Vec::new();
    if enabled.iter().any(|name| name == "read") {
        specs.push(tool_definition("read", "Read a workspace file, or list a workspace directory.", json!({ "filePath": {"type":"string"}, "offset":{"type":"number"}, "limit":{"type":"number"}, "depth":{"type":"number"} }), &["filePath"]));
    }
    if enabled.iter().any(|name| name == "write") {
        specs.push(tool_definition(
            "write",
            "Write a workspace file after permission.",
            json!({ "filePath":{"type":"string"}, "content":{"type":"string"} }),
            &["filePath", "content"],
        ));
    }
    if enabled.iter().any(|name| name == "edit") {
        specs.push(tool_definition("edit", "Replace exact text in one workspace file after permission.", json!({ "filePath":{"type":"string"}, "oldText":{"type":"string"}, "newText":{"type":"string"} }), &["filePath","oldText","newText"]));
    }
    if enabled.iter().any(|name| name == "search") {
        specs.push(tool_definition(
            "search",
            "Search workspace file paths and small text-file contents.",
            json!({ "query":{"type":"string"}, "limit":{"type":"number"} }),
            &["query"],
        ));
    }
    if enabled.iter().any(|name| name == "workspace_graph") && session.workspace_graph.is_some() {
        specs.push(tool_definition("workspace_graph", "Query bounded source-backed workspace graph evidence.", json!({ "action":{"type":"string","enum":["summary","query","explain","path","affected"]}, "query":{"type":"string"}, "symbol":{"type":"string"}, "from":{"type":"string"}, "to":{"type":"string"}, "files":{"type":"array","items":{"type":"string"}}, "symbols":{"type":"array","items":{"type":"string"}}, "depth":{"type":"number"}, "limit":{"type":"number"}, "maxDepth":{"type":"number"}, "direction":{"type":"string","enum":["incoming","outgoing","both"]} }), &["action"]));
    }
    if enabled.iter().any(|name| name == "command") {
        specs.push(tool_definition(
            "command",
            "Run a local workspace shell command after policy and permission checks.",
            json!({ "command":{"type":"string"}, "timeoutMs":{"type":"number"} }),
            &["command"],
        ));
    }
    if !session.config.skills.is_empty() {
        specs.push(tool_definition("read_skill", "Read complete instructions for one enabled skill before applying it.", json!({ "skillId":{"type":"string"}, "resource":{"type":"string"}, "offset":{"type":"number"}, "limit":{"type":"number"} }), &["skillId"]));
    }
    if session.context_store.lock().await.has_entries() {
        specs.push(tool_definition("retrieve_context", "Retrieve a bounded window of exact compacted local tool output.", json!({ "hash":{"type":"string"}, "offset":{"type":"number"}, "limit":{"type":"number"} }), &["hash"]));
    }
    specs
}

pub fn canonical_tool_name(name: &str) -> String {
    name.trim().to_ascii_lowercase()
}

pub async fn execute_tool(
    session: Arc<Session>,
    sink: EventSink,
    permissions: Arc<crate::permission::PermissionBroker>,
    call: ToolCall,
) -> ToolResult {
    let started_at = now_iso();
    let started = Instant::now();
    let name = canonical_tool_name(&call.name);
    let parsed_args = parse_arguments(&call.arguments);
    let summary = match parsed_args.as_ref() {
        Ok(args) => match name.as_str() {
            "read" => format!("read {}", string_arg(args, &["filePath", "path"])),
            "write" => format!("write {}", string_arg(args, &["filePath", "path"])),
            "edit" => format!("edit {}", string_arg(args, &["filePath", "path"])),
            "search" => format!("search {}", string_arg(args, &["query"])),
            "command" => redact_text(&string_arg(args, &["command"]), 320),
            other => other.to_owned(),
        },
        Err(_) => name.clone(),
    };
    let command_class = match parsed_args.as_ref() {
        Ok(args) if name == "command" => {
            classify_command_text(&string_arg(args, &["command"]), Some(&session.config.cwd))
                .command_class
        }
        Ok(_) if matches!(name.as_str(), "write" | "edit") => "edit",
        Ok(_) => "read",
        Err(_) => "unknown",
    };
    sink.emit(json!({ "type":"tool.requested", "taskId":session.task_id, "toolCallId":call.id, "toolKind":name, "arguments":call.arguments.clone(), "commandClass":command_class, "summary":summary, "cwd":session.config.cwd, "at":started_at }));
    let args = match parsed_args {
        Ok(value) => value,
        Err(error) => {
            sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"blocked", "reason":"invalid_arguments", "at":now_iso() }));
            return finish_failure(
                &session,
                &sink,
                &call,
                &name,
                &started_at,
                started,
                "validation_error",
                "invalid_arguments",
                error,
            );
        }
    };
    if let Err(error) = validate_arguments(&name, &args) {
        sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"blocked", "reason":"invalid_arguments", "at":now_iso() }));
        return finish_failure(
            &session,
            &sink,
            &call,
            &name,
            &started_at,
            started,
            "validation_error",
            "invalid_arguments",
            error,
        );
    }
    if session.is_aborted() {
        sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"blocked", "reason":"aborted", "at":now_iso() }));
        return finish_failure(
            &session,
            &sink,
            &call,
            &name,
            &started_at,
            started,
            "aborted",
            "aborted",
            "Tool call was aborted.".into(),
        );
    }
    let internal = matches!(name.as_str(), "read_skill" | "retrieve_context");
    if !internal
        && !session
            .config
            .enabled_tools
            .iter()
            .any(|enabled| enabled == &name)
    {
        sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"blocked", "reason":"tool_disabled", "at":now_iso() }));
        return finish_failure(
            &session,
            &sink,
            &call,
            &name,
            &started_at,
            started,
            "validation_error",
            "tool_disabled",
            format!("Tool {name} is disabled."),
        );
    }
    sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"passed", "at":now_iso() }));
    let result = match name.as_str() {
        "read" => read_tool(&session, &args).await,
        "write" => write_tool(&session, &sink, &args, &permissions).await,
        "edit" => edit_tool(&session, &sink, &args, &permissions).await,
        "search" => search_tool(&session, &args).await,
        "workspace_graph" => session
            .workspace_graph
            .as_ref()
            .map(|service| {
                ToolResult::success(
                    format!("workspace_graph {}", string_arg(&args, &["action"])),
                    service.query(&Value::Object(args.clone())).to_string(),
                )
            })
            .ok_or_else(|| "Workspace graph is not configured for this session.".into()),
        "command" => command_tool(&session, &sink, &args, &permissions, &call.id).await,
        "read_skill" => read_skill_tool(&session, &args),
        "retrieve_context" => {
            let hash = string_arg(&args, &["hash"]);
            let mut store = session.context_store.lock().await;
            store.retrieve(&hash, args.get("offset").and_then(Value::as_u64).map(|value| value as usize), args.get("limit").and_then(Value::as_u64).map(|value| value as usize)).map(|window| { sink.emit(json!({"type":"context.retrieved","taskId":session.task_id,"toolCallId":call.id,"hash":window.entry.hash,"offset":window.offset,"bytesShown":window.bytes_shown,"totalBytes":window.entry.original_bytes,"at":now_iso()})); let status = window.next_offset.map(|value| format!("Next offset: {value}")).unwrap_or_else(|| if window.entry.original_truncated { format!("Read status: stored copy complete; original output was capped at {} of {} bytes", window.entry.stored_bytes, window.entry.original_bytes) } else { "Read status: complete".into() }); ToolResult::success(hash.clone(), format!("Retrieved context {}\nKind: {}\nStrategy: {}\nBytes shown: {}-{} of {}\n{}\n\n{}", window.entry.hash, window.entry.kind, window.entry.strategy, window.offset, window.offset + window.bytes_shown, window.entry.original_bytes, status, window.content)) }).ok_or_else(|| format!("No stored context found for hash {hash}."))
        }
        _ => Err(format!("Unknown tool: {name}")),
    };
    match result {
        Ok(mut result) => {
            if name != "command" && !result.output.is_empty() {
                sink.emit(json!({ "type":"tool.output", "taskId":session.task_id, "toolCallId":call.id, "stream":"stdout", "text":result.output, "redacted":true, "at":now_iso() }));
            }
            let mut store = session.context_store.lock().await;
            let compressed = compress_tool_result(
                &mut store,
                &name,
                &call.id,
                &result.title,
                &result.output,
                &result.status,
            );
            if compressed.modified {
                sink.emit(json!({"type":"context.compressed","taskId":session.task_id,"toolCallId":call.id,"toolKind":name,"kind":compressed.kind,"strategy":compressed.strategy,"hash":compressed.marker_hash,"originalBytes":compressed.original_bytes,"outputBytes":compressed.output_bytes,"at":now_iso()}));
                result.output = compressed.output;
            }
            let failure_response = if result.status == "success" {
                Value::Null
            } else {
                Value::String(
                    result
                        .error_message
                        .clone()
                        .unwrap_or_else(|| result.output.clone()),
                )
            };
            sink.emit(json!({ "type":"tool.finished", "taskId":session.task_id, "toolCallId":call.id, "exitCode":result.exit_code, "status":result.status, "errorCode":result.error_code, "errorMessage":result.error_message, "response":failure_response, "startedAt":started_at, "finishedAt":now_iso(), "durationMs":started.elapsed().as_secs_f64()*1000.0, "at":now_iso() }));
            result
        }
        Err(error) => {
            let (status, code) = if error.to_ascii_lowercase().contains("denied") {
                ("permission_denied", "permission_denied")
            } else if error.to_ascii_lowercase().contains("outside")
                || error.to_ascii_lowercase().contains("blocked")
            {
                ("policy_blocked", "policy_blocked")
            } else {
                ("validation_error", "invalid_arguments")
            };
            finish_failure(
                &session,
                &sink,
                &call,
                &name,
                &started_at,
                started,
                status,
                code,
                error,
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_failure(
    session: &Session,
    sink: &EventSink,
    call: &ToolCall,
    name: &str,
    started_at: &str,
    started: Instant,
    status: &str,
    code: &str,
    message: String,
) -> ToolResult {
    sink.emit(json!({ "type":"tool.finished", "taskId":session.task_id, "toolCallId":call.id, "exitCode":1, "status":status, "errorCode":code, "errorMessage":redact_text(&message,500), "response":message.clone(), "startedAt":started_at, "finishedAt":now_iso(), "durationMs":started.elapsed().as_secs_f64()*1000.0, "at":now_iso() }));
    let mut result = ToolResult::failure(status, code, message);
    result.title = name.to_owned();
    result
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    #[test]
    fn markdown_fenced_arguments_parse() {
        let value = Value::String("```json\n{\"filePath\":\"README.md\"}\n```".into());
        assert_eq!(
            parse_arguments(&value)
                .unwrap()
                .get("filePath")
                .and_then(Value::as_str),
            Some("README.md")
        );
    }
    #[test]
    fn patch_parser_rejects_malformed_input() {
        assert!(parse_patch("not a patch").is_err());
    }
    #[test]
    fn search_query_supports_constraints_globs_smart_case_and_locations() {
        let parsed =
            parse_search_query("src/ src/**/*.tsx !test/ !*.min.js Button service.ts:42:7");
        assert_eq!(parsed.include_dirs, ["src/"]);
        assert_eq!(parsed.include_globs, ["src/**/*.tsx"]);
        assert_eq!(parsed.exclude_dirs, ["test/"]);
        assert_eq!(parsed.exclude_globs, ["*.min.js"]);
        assert_eq!(parsed.terms, ["Button"]);
        assert_eq!(parsed.location.as_deref(), Some("service.ts"));
        assert!(parsed.smart_case);
        assert!(term_score("src/components/Button.ts", "Button.ts", "Buton.ts", false) > 0.0);
    }

    #[tokio::test]
    async fn invalid_calls_still_emit_one_requested_and_one_finished_event() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let result = execute_tool(
            session,
            sink,
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "bad-call".into(),
                name: "read".into(),
                arguments: Value::String("not-json".into()),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "validation_error");
        assert_eq!(result.error_code.as_deref(), Some("invalid_arguments"));

        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(
            observed
                .iter()
                .filter(|event| event["type"] == "tool.requested")
                .count(),
            1
        );
        assert_eq!(
            observed
                .iter()
                .filter(|event| event["type"] == "tool.finished")
                .count(),
            1
        );
        let policy = observed
            .iter()
            .find(|event| event["type"] == "tool.policy.stage")
            .unwrap();
        assert_eq!(policy["outcome"], "blocked");
        assert_eq!(policy["reason"], "invalid_arguments");
    }

    #[tokio::test]
    async fn disabled_and_aborted_calls_keep_complete_lifecycles() {
        let directory = tempfile::tempdir().unwrap();
        let mut config = (*crate::session::test_config(directory.path())).clone();
        config.enabled_tools.clear();
        let session = Arc::new(Session {
            id: "session".into(),
            task_id: "task".into(),
            config: Arc::new(config),
            messages: tokio::sync::Mutex::new(Vec::new()),
            context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
            workspace_graph: None,
            aborted: std::sync::atomic::AtomicBool::new(false),
        });
        let permissions = Arc::new(crate::permission::PermissionBroker::default());
        for (id, expected) in [("disabled", "tool_disabled"), ("aborted", "aborted")] {
            let sink = crate::session::test_sink(directory.path());
            let mut events = sink.subscribe();
            if id == "aborted" {
                session.abort();
            }
            let result = execute_tool(
                session.clone(),
                sink,
                permissions.clone(),
                ToolCall {
                    id: id.into(),
                    name: "read".into(),
                    arguments: json!({"filePath":"README.md"}),
                    index: 0,
                },
            )
            .await;
            assert_eq!(result.error_code.as_deref(), Some(expected));
            let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
            assert_eq!(observed.first().unwrap()["type"], "tool.requested");
            assert_eq!(
                observed.first().unwrap()["arguments"]["filePath"],
                "README.md"
            );
            assert_eq!(observed.last().unwrap()["type"], "tool.finished");
            assert!(observed.last().unwrap()["response"].as_str().is_some());
            assert_eq!(
                observed
                    .iter()
                    .filter(|event| event["type"] == "tool.finished")
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn patch_mode_adds_updates_moves_and_deletes_atomically() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("source.txt"), "before\n").unwrap();
        std::fs::write(directory.path().join("delete.txt"), "remove\n").unwrap();
        let session = crate::session::test_session(directory.path());
        let sink = crate::session::test_sink(directory.path());
        let result = execute_tool(
            session,
            sink,
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "patch".into(),
                name: "edit".into(),
                arguments: json!({"mode":"patch","patch":"*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** Delete File: delete.txt\n*** Add File: added.txt\n+new file\n*** End Patch"}),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "success", "{:?}", result.error_message);
        assert!(!directory.path().join("source.txt").exists());
        assert!(!directory.path().join("delete.txt").exists());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("moved.txt")).unwrap(),
            "after\n"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("added.txt")).unwrap(),
            "new file"
        );
    }

    #[tokio::test]
    async fn read_rejects_paths_outside_the_workspace() {
        let parent = tempfile::tempdir().unwrap();
        let workspace = parent.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(parent.path().join("secret.txt"), "TOP_SECRET_CONTENT").unwrap();
        let result = execute_tool(
            crate::session::test_session(&workspace),
            crate::session::test_sink(&workspace),
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "escape".into(),
                name: "read".into(),
                arguments: json!({"filePath":"../secret.txt"}),
                index: 0,
            },
        )
        .await;
        assert_eq!(result.status, "policy_blocked");
        assert!(!result.output.contains("TOP_SECRET_CONTENT"));
    }

    async fn execute_command_for_test(command: &str, timeout_ms: u64) -> ToolResult {
        let directory = tempfile::tempdir().unwrap();
        execute_tool(
            crate::session::test_session(directory.path()),
            crate::session::test_sink(directory.path()),
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "command".into(),
                name: "command".into(),
                arguments: json!({"command":command,"timeoutMs":timeout_ms}),
                index: 0,
            },
        )
        .await
    }

    #[tokio::test]
    async fn commands_report_success_nonzero_exit_and_timeout_distinctly() {
        let success = execute_command_for_test("echo runner-command-ok", 5_000).await;
        assert_eq!(success.status, "success");
        assert!(success.output.contains("runner-command-ok"));

        let failure = execute_command_for_test("exit 7", 5_000).await;
        assert_eq!(failure.status, "runtime_error");
        assert_eq!(failure.error_code.as_deref(), Some("command_exit_nonzero"));
        assert_eq!(failure.exit_code, Some(7));

        let command = if cfg!(windows) {
            "Start-Sleep -Milliseconds 1000"
        } else {
            "sleep 1"
        };
        let timeout = execute_command_for_test(command, 100).await;
        assert_eq!(timeout.status, "timeout");
        assert_eq!(timeout.error_code.as_deref(), Some("process_timeout"));
    }

    #[tokio::test]
    async fn read_skill_is_limited_to_enabled_skill_resources() {
        let directory = tempfile::tempdir().unwrap();
        let skill_root = directory.path().join("skill");
        std::fs::create_dir(&skill_root).unwrap();
        let skill_path = skill_root.join("SKILL.md");
        std::fs::write(&skill_path, "main instructions").unwrap();
        std::fs::write(skill_root.join("reference.md"), "reference body").unwrap();
        std::fs::write(directory.path().join("secret.txt"), "TOP_SECRET_SKILL").unwrap();
        let mut config = (*crate::session::test_config(directory.path())).clone();
        config.skills.push(crate::config::RunnerSkillConfig {
            id: "test-skill".into(),
            name: "Test".into(),
            description: String::new(),
            source: "local".into(),
            instruction_path: skill_path,
        });
        let session = Arc::new(Session {
            id: "session".into(),
            task_id: "task".into(),
            config: Arc::new(config),
            messages: tokio::sync::Mutex::new(Vec::new()),
            context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
            workspace_graph: None,
            aborted: std::sync::atomic::AtomicBool::new(false),
        });
        let permissions = Arc::new(crate::permission::PermissionBroker::default());
        let allowed = execute_tool(
            session.clone(),
            crate::session::test_sink(directory.path()),
            permissions.clone(),
            ToolCall {
                id: "allowed".into(),
                name: "read_skill".into(),
                arguments: json!({"skillId":"test-skill","resource":"reference.md","limit":100}),
                index: 0,
            },
        )
        .await;
        assert_eq!(allowed.status, "success");
        assert!(allowed.output.contains("reference body"));

        let blocked = execute_tool(
            session,
            crate::session::test_sink(directory.path()),
            permissions,
            ToolCall {
                id: "blocked".into(),
                name: "read_skill".into(),
                arguments: json!({"skillId":"test-skill","resource":"../secret.txt"}),
                index: 0,
            },
        )
        .await;
        assert_eq!(blocked.status, "policy_blocked");
        assert!(!blocked.output.contains("TOP_SECRET_SKILL"));
    }
}
