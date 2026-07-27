use super::*;

pub(super) async fn write_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
) -> ToolExecutionResult {
    let path = string_arg(input, &["filePath", "file_path", "path"]);
    let content = input
        .get("content")
        .or_else(|| input.get("text"))
        .and_then(Value::as_str)
        .ok_or_else(|| "write requires string argument content".to_owned())?;
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &path).map_err(ToolError::policy)?;
    let decision = permissions
        .request(
            sink,
            &session.task_id,
            "edit",
            &format!("write {relative}"),
            session.config.permission_mode == PermissionMode::AutoSafe,
        )
        .await;
    if decision != "allow" {
        return Err(ToolError::permission(format!("Write denied: {relative}")));
    }
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent).map_err(|error| ToolError::runtime(error.to_string()))?;
    }
    let target =
        confirm_workspace_write_path(&session.config.cwd, &absolute).map_err(ToolError::policy)?;
    fs::write(&target, content).map_err(|error| ToolError::runtime(error.to_string()))?;
    Ok(ToolResult::success(
        relative.clone(),
        "Wrote file successfully.",
    ))
}

pub(super) async fn edit_tool(
    session: &Session,
    sink: &EventSink,
    input: &Map<String, Value>,
    permissions: &crate::permission::PermissionBroker,
) -> ToolExecutionResult {
    let has_file_path = ["filePath", "file_path", "path"]
        .iter()
        .any(|name| input.contains_key(*name));
    let patch_mode = input.get("mode").and_then(Value::as_str) == Some("patch")
        || (input.contains_key("patch") && !has_file_path);
    if patch_mode {
        let patch = input
            .get("patch")
            .and_then(Value::as_str)
            .ok_or_else(|| "edit patch mode requires patch content".to_owned())?;
        let transaction = patch::plan_patch(session, patch)?;
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
        if decision != "allow" {
            return Err(ToolError::permission("Patch edit denied"));
        }
        patch::commit_patch(&session.config.cwd, transaction).map_err(ToolError::runtime)?;
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
    let path = string_arg(input, &["filePath", "file_path", "path"]);
    let old = string_arg(input, &["oldText", "old_string", "old", "find"]);
    let new = string_arg(input, &["newText", "new_string", "new", "replace"]);
    if old.is_empty() {
        return Err("edit replace mode requires oldText".into());
    }
    if patch::normalized_line_endings(&old) == patch::normalized_line_endings(&new) {
        return Err("edit replacement must change the file".into());
    }
    let (absolute, relative) =
        resolve_workspace_path(&session.config.cwd, &path).map_err(ToolError::policy)?;
    let current = ensure_text_file(&absolute)?;
    let updated = patch::replace_text_block(&current, &old, &new).ok_or_else(|| {
        format!(
            "Text to replace was not found in {relative}. Read the current range and retry, or use edit patch mode."
        )
    })?;
    let decision = permissions
        .request(
            sink,
            &session.task_id,
            "edit",
            &format!("edit {relative}"),
            session.config.permission_mode == PermissionMode::AutoSafe,
        )
        .await;
    if decision != "allow" {
        return Err(ToolError::permission(format!("Edit denied: {relative}")));
    }
    let target =
        confirm_workspace_write_path(&session.config.cwd, &absolute).map_err(ToolError::policy)?;
    fs::write(target, updated).map_err(|error| ToolError::runtime(error.to_string()))?;
    Ok(ToolResult::success(relative, "Edited file successfully."))
}
