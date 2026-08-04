use std::io::Write;

use uuid::Uuid;

use super::{patch, *};

const MAX_DIFF_BYTES: usize = 8 * 1024;
const MAX_EDITS_PER_CALL: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
enum FileSnapshot {
    Missing,
    Text(String),
}

pub(super) async fn write_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
) -> ToolExecutionResult {
    let path = string_arg(input, &["path"]);
    let content = input
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "write requires string argument content".to_owned())?;
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &path).map_err(ToolError::policy)?;
    let snapshot = snapshot_text_path(&absolute)?;
    let effect = match &snapshot {
        FileSnapshot::Missing => "created",
        FileSnapshot::Text(_) => "replaced",
    };
    let decision = permissions
        .request(
            sink,
            &session.task_id,
            "edit",
            &format!("write {relative}"),
            session.config.permission_mode == PermissionMode::AutoSafe,
        )
        .await;
    if decision == "abort" {
        return Err(ToolError::aborted(
            "The tool call was aborted before the write ran. The file was not changed.",
        ));
    }
    if decision != "allow" {
        return Err(ToolError::permission(format!(
            "The user rejected the write to {relative}. The file was not changed. Do not repeat it unless the user makes a new request that authorizes it."
        )));
    }
    revalidate_snapshot(&absolute, &snapshot)?;
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent).map_err(|error| ToolError::runtime(error.to_string()))?;
    }
    let target =
        confirm_workspace_write_path(&session.config.cwd, &absolute).map_err(ToolError::policy)?;
    atomic_write_text(&session.config.cwd, &target, content)?;
    let bytes = content.len();
    Ok(ToolResult::success_detailed(
        relative.clone(),
        format!("Wrote {bytes} UTF-8 bytes ({effect})."),
        Some(json!({
            "path": relative,
            "bytes": bytes,
            "effect": effect,
        })),
        None,
    ))
}

pub(super) async fn edit_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
) -> ToolExecutionResult {
    let path = string_arg(input, &["path"]);
    let edits = parse_edits(input)?;
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &path).map_err(ToolError::policy)?;
    let current = ensure_text_file(&absolute).map_err(mutation_source_error)?;
    let snapshot = FileSnapshot::Text(current.clone());
    let planned = apply_exact_edits(&current, &edits)?;
    let decision = permissions
        .request(
            sink,
            &session.task_id,
            "edit",
            &format!("edit {relative}"),
            session.config.permission_mode == PermissionMode::AutoSafe,
        )
        .await;
    if decision == "abort" {
        return Err(ToolError::aborted(format!(
            "The tool call was aborted before the edit to {relative} ran. The file was not changed."
        )));
    }
    if decision != "allow" {
        return Err(ToolError::permission(format!(
            "The user rejected the edit to {relative}. The file was not changed. Do not repeat it unless the user makes a new request that authorizes it."
        )));
    }
    revalidate_snapshot(&absolute, &snapshot)?;
    let target =
        confirm_workspace_write_path(&session.config.cwd, &absolute).map_err(ToolError::policy)?;
    atomic_write_text(&session.config.cwd, &target, &planned.updated)?;
    let diff = patch::bounded_unified_diff(&relative, &current, &planned.updated, MAX_DIFF_BYTES);
    Ok(ToolResult::success_detailed(
        format!(
            "Edited {relative} (first changed line {})",
            planned.first_changed_line
        ),
        diff,
        Some(json!({
            "path": relative,
            "editsApplied": edits.len(),
            "firstChangedLine": planned.first_changed_line,
            "bytes": planned.updated.len(),
        })),
        None,
    ))
}

pub(super) async fn apply_patch_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
) -> ToolExecutionResult {
    let patch = input
        .get("patch")
        .and_then(Value::as_str)
        .ok_or_else(|| "apply_patch requires patch content".to_owned())?;
    let transaction = patch::plan_patch(session, patch).map_err(ToolError::validation)?;
    let summaries = transaction.summaries().to_vec();
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
            session.config.permission_mode == PermissionMode::AutoSafe,
        )
        .await;
    if decision == "abort" {
        return Err(ToolError::aborted(
            "The tool call was aborted before the patch ran. No file was changed.",
        ));
    }
    if decision != "allow" {
        return Err(ToolError::permission(
            "The user rejected the patch. No file was changed. Do not repeat it unless the user makes a new request that authorizes it.",
        ));
    }
    transaction
        .revalidate()
        .map_err(|message| ToolError::runtime_code("stale_source", message))?;
    let committed =
        patch::commit_patch(&session.config.cwd, transaction).map_err(|error| match error {
            patch::PatchCommitError::RollbackFailed { message, .. } => {
                ToolError::runtime_code("rollback_failed", message)
            }
            patch::PatchCommitError::Failed { message, .. } => ToolError::runtime(message),
        })?;
    let mut lines = vec![format!(
        "Patched {} file{} successfully.",
        committed.effects.len(),
        if committed.effects.len() == 1 {
            ""
        } else {
            "s"
        }
    )];
    for effect in &committed.effects {
        lines.push(format!("- {}", effect.summary));
    }
    if !committed.diff.is_empty() {
        lines.push(String::new());
        lines.push(committed.diff.clone());
    }
    Ok(ToolResult::success_detailed(
        "patch",
        lines.join("\n"),
        Some(json!({
            "effects": committed.effects.iter().map(|effect| json!({
                "path": effect.path,
                "action": effect.action,
            })).collect::<Vec<_>>(),
        })),
        None,
    ))
}

fn parse_edits(input: &Map<String, Value>) -> Result<Vec<(String, String)>, ToolError> {
    let Some(Value::Array(edits)) = input.get("edits") else {
        return Err(ToolError::validation(
            "edit requires edits as a non-empty array",
        ));
    };
    if edits.is_empty() {
        return Err(ToolError::validation(
            "edit requires at least one entry in edits",
        ));
    }
    if edits.len() > MAX_EDITS_PER_CALL {
        return Err(ToolError::validation(format!(
            "edit accepts at most {MAX_EDITS_PER_CALL} replacements"
        )));
    }
    let mut parsed = Vec::with_capacity(edits.len());
    for (index, edit) in edits.iter().enumerate() {
        let Some(object) = edit.as_object() else {
            return Err(ToolError::validation(format!(
                "edits[{index}] must be an object"
            )));
        };
        for key in object.keys() {
            if key != "oldText" && key != "newText" {
                return Err(ToolError::validation(format!(
                    "edits[{index}] received undeclared field {key}"
                )));
            }
        }
        let Some(old) = object.get("oldText").and_then(Value::as_str) else {
            return Err(ToolError::validation(format!(
                "edits[{index}].oldText must be a non-empty string"
            )));
        };
        let Some(new) = object.get("newText").and_then(Value::as_str) else {
            return Err(ToolError::validation(format!(
                "edits[{index}].newText must be a string"
            )));
        };
        if old.is_empty() {
            return Err(ToolError::validation(format!(
                "edits[{index}].oldText must be non-empty"
            )));
        }
        if old == new {
            return Err(ToolError::validation(format!(
                "edits[{index}] must change the matched text"
            )));
        }
        parsed.push((old.to_owned(), new.to_owned()));
    }
    Ok(parsed)
}

struct PlannedEdit {
    updated: String,
    first_changed_line: u64,
}

fn mutation_source_error(message: String) -> ToolError {
    if message.contains("-byte limit for tools that rewrite a whole file") {
        return ToolError::validation_code("file_too_large", message);
    }
    ToolError::validation(message)
}

fn apply_exact_edits(original: &str, edits: &[(String, String)]) -> Result<PlannedEdit, ToolError> {
    let mut ranges = Vec::with_capacity(edits.len());
    for (index, (old, new)) in edits.iter().enumerate() {
        // Byte-exact, unique-or-reject: the same policy apply_patch uses for a hunk.
        match patch::unique_match(original, old) {
            Ok(start) => ranges.push((start, start + old.len(), new.as_str(), index)),
            Err(patch::UniqueMatch::Missing) => {
                return Err(ToolError::validation_code(
                    "edit_not_found",
                    format!(
                        "edits[{index}].oldText was not found. Read the current file and copy the exact text."
                    ),
                ));
            }
            Err(patch::UniqueMatch::Ambiguous(count)) => {
                return Err(ToolError::validation_code(
                    "edit_ambiguous",
                    format!(
                        "edits[{index}].oldText matched {count} times; each replacement must be unique."
                    ),
                ));
            }
        }
    }
    ranges.sort_by_key(|(start, _, _, _)| *start);
    for window in ranges.windows(2) {
        let (_, end, _, left) = window[0];
        let (start, _, _, right) = window[1];
        if start < end {
            return Err(ToolError::validation_code(
                "edit_overlap",
                format!("edits[{left}] and edits[{right}] overlap in the original file"),
            ));
        }
    }
    let mut updated = String::with_capacity(original.len());
    let mut cursor = 0usize;
    for (start, end, new, _) in &ranges {
        updated.push_str(&original[cursor..*start]);
        updated.push_str(new);
        cursor = *end;
    }
    updated.push_str(&original[cursor..]);
    if updated == original {
        return Err(ToolError::validation(
            "edit replacements must change the file",
        ));
    }
    Ok(PlannedEdit {
        first_changed_line: first_changed_line(original, &updated).unwrap_or(1),
        updated,
    })
}

fn snapshot_text_path(path: &Path) -> Result<FileSnapshot, ToolError> {
    if !path.exists() {
        return Ok(FileSnapshot::Missing);
    }
    let metadata = fs::metadata(path).map_err(|error| ToolError::runtime(error.to_string()))?;
    if !metadata.is_file() {
        return Err(ToolError::validation("Path is not a file"));
    }
    Ok(FileSnapshot::Text(
        ensure_text_file(path).map_err(mutation_source_error)?,
    ))
}

fn revalidate_snapshot(path: &Path, expected: &FileSnapshot) -> Result<(), ToolError> {
    let current = snapshot_text_path(path)?;
    if &current == expected {
        return Ok(());
    }
    Err(ToolError::runtime_code(
        "stale_source",
        "The file changed after the tool call was planned. Re-read it and retry; no mutation was applied.",
    ))
}

pub(super) fn atomic_write_text(
    root: &Path,
    target: &Path,
    content: &str,
) -> Result<(), ToolError> {
    let target = confirm_workspace_write_path(root, target).map_err(ToolError::policy)?;
    let parent = target
        .parent()
        .ok_or_else(|| ToolError::runtime("Write target does not have a parent directory"))?;
    let staged = unique_sibling_path(root, parent, "staged")?;
    let write_staged = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged)
            .map_err(|error| error.to_string())?;
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = write_staged {
        let _ = fs::remove_file(&staged);
        return Err(ToolError::runtime(error));
    }
    if target.exists() {
        let backup = unique_sibling_path(root, parent, "backup")?;
        if let Err(error) = fs::rename(&target, &backup) {
            let _ = fs::remove_file(&staged);
            return Err(ToolError::runtime(error.to_string()));
        }
        if let Err(error) = fs::rename(&staged, &target) {
            let rollback = fs::rename(&backup, &target);
            let _ = fs::remove_file(&staged);
            return if rollback.is_ok() {
                Err(ToolError::runtime(error.to_string()))
            } else {
                Err(ToolError::runtime_code(
                    "rollback_failed",
                    format!(
                        "Atomic write failed ({error}) and restoring the original also failed."
                    ),
                ))
            };
        }
        let _ = fs::remove_file(&backup);
        return Ok(());
    }
    if let Err(error) = fs::rename(&staged, &target) {
        let _ = fs::remove_file(&staged);
        return Err(ToolError::runtime(error.to_string()));
    }
    Ok(())
}

fn unique_sibling_path(root: &Path, parent: &Path, kind: &str) -> Result<PathBuf, ToolError> {
    loop {
        let candidate = parent.join(format!(".umbratic-write-{}-{kind}", Uuid::new_v4()));
        let candidate =
            confirm_workspace_write_path(root, &candidate).map_err(ToolError::policy)?;
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
}

fn first_changed_line(before: &str, after: &str) -> Option<u64> {
    let before_lines = before.split_inclusive('\n').collect::<Vec<_>>();
    let after_lines = after.split_inclusive('\n').collect::<Vec<_>>();
    let shared = before_lines.len().min(after_lines.len());
    for index in 0..shared {
        if before_lines[index] != after_lines[index] {
            return Some((index + 1) as u64);
        }
    }
    if before_lines.len() != after_lines.len() {
        Some((shared + 1) as u64)
    } else {
        None
    }
}
