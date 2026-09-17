use super::*;

pub(super) fn read_skill_tool(
    session: &Session,
    input: &Map<String, Value>,
) -> ToolExecutionResult {
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
                return Err(ToolError::policy(
                    "Refusing skill resource outside its skill folder.",
                ));
            }
            if is_blocked_path(raw) {
                return Err(ToolError::policy(format!(
                    "Refusing blocked skill resource: {raw}"
                )));
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
    session
        .skill_cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record_read(&skill.id, &target, &content, start, end);
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

/// The artifact interface is schema-driven. An enabled bundled format skill
/// supplies that schema; refuse execution until its actual bytes were read in
/// this turn, rather than treating a cached skill or the last page as a read.
pub(super) fn require_artifact_skill(
    session: &Session,
    action: &str,
    format: &str,
) -> Result<(), ToolError> {
    let id = match format {
        "docx" => "umbratic-documents",
        "pptx" => "umbratic-presentations",
        "xlsx" => "umbratic-spreadsheets",
        "pdf" => "umbratic-pdf",
        _ => return Ok(()),
    };
    let Some(skill) = session.config.skills.iter().find(|skill| skill.id == id) else {
        return Ok(());
    };
    let reference = match action {
        "create" => Some("references/spec.md"),
        "edit" => Some("references/ops.md"),
        _ => None,
    };
    let primary = skill.instruction_path.canonicalize().ok();
    let mut missing = Vec::new();
    for resource in std::iter::once("SKILL.md").chain(reference) {
        let target = primary.as_ref().and_then(|primary| {
            if resource == "SKILL.md" {
                Some(primary.clone())
            } else {
                let root = primary.parent()?;
                root.join(resource)
                    .canonicalize()
                    .ok()
                    .filter(|path| path.starts_with(root))
            }
        });
        let complete = target.as_ref().is_some_and(|path| {
            ensure_text_file(path).ok().is_some_and(|content| {
                session
                    .skill_cache
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .was_read_completely(id, path, &content)
            })
        });
        if !complete {
            missing.push(json!({ "skillId": id, "resource": resource }));
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(ToolError::validation_code(
            "skill_read_required",
            format!(
                "artifact {action} requires complete skill reads for this request before execution. Call read_skill with each of these arguments, following any Next offset to completion: {}. No document engine job was started.",
                serde_json::to_string(&missing).unwrap()
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn setup(root: &Path, id: &str) -> Arc<Session> {
        let directory = root.join(id);
        fs::create_dir_all(directory.join("references")).unwrap();
        fs::write(directory.join("SKILL.md"), "abcdefghijklmnop").unwrap();
        fs::write(directory.join("references/spec.md"), "create schema").unwrap();
        fs::write(directory.join("references/ops.md"), "edit schema").unwrap();
        let mut session = crate::session::test_session(root);
        let mut config = (*session.config).clone();
        config.skills.push(crate::config::RunnerSkillConfig {
            id: id.into(),
            name: "Format".into(),
            description: String::new(),
            source: "system".into(),
            instruction_path: directory.join("SKILL.md"),
            paths: Vec::new(),
        });
        Arc::get_mut(&mut session).unwrap().config = Arc::new(config);
        session
    }

    fn read(session: &Session, id: &str, resource: &str, offset: usize, limit: usize) {
        read_skill_tool(
            session,
            json!({"skillId":id,"resource":resource,"offset":offset,"limit":limit})
                .as_object()
                .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn each_format_requires_complete_current_skill_and_action_schema() {
        for (format, id) in [
            ("docx", "umbratic-documents"),
            ("pptx", "umbratic-presentations"),
            ("xlsx", "umbratic-spreadsheets"),
            ("pdf", "umbratic-pdf"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let session = setup(directory.path(), id);
            // Merely caching the instructions is not evidence the model read them.
            crate::skill_preflight::load_or_cache_skill(&session, &session.config.skills[0])
                .unwrap();
            assert!(require_artifact_skill(&session, "inspect", format).is_err());
            // Reading the end reports complete, but a hole must still block execution.
            read(&session, id, "SKILL.md", 8, 8);
            read(&session, id, "SKILL.md", 0, 4);
            assert!(require_artifact_skill(&session, "inspect", format).is_err());
            read(&session, id, "SKILL.md", 4, 4);
            assert!(require_artifact_skill(&session, "inspect", format).is_ok());
            assert!(require_artifact_skill(&session, "create", format).is_err());
            read(&session, id, "./references/spec.md", 0, 100);
            assert!(require_artifact_skill(&session, "create", format).is_ok());
            assert!(require_artifact_skill(&session, "edit", format).is_err());
            read(&session, id, "references/ops.md", 0, 100);
            assert!(require_artifact_skill(&session, "edit", format).is_ok());
            fs::write(
                directory.path().join(id).join("references/ops.md"),
                "changed schema",
            )
            .unwrap();
            assert!(require_artifact_skill(&session, "edit", format).is_err());
            session.skill_cache.lock().unwrap().begin_turn();
            assert!(require_artifact_skill(&session, "inspect", format).is_err());
        }
    }

    #[test]
    fn disabled_skills_are_not_execution_prerequisites() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        assert!(require_artifact_skill(&session, "create", "docx").is_ok());
    }

    #[tokio::test]
    async fn unread_schema_stops_before_permission_and_engine_requests() {
        let directory = tempfile::tempdir().unwrap();
        let session = setup(directory.path(), "umbratic-documents");
        let sink = crate::session::test_sink(directory.path());
        let mut events = sink.subscribe();
        let result = super::super::execute_tool(
            session,
            sink,
            Arc::new(crate::permission::PermissionBroker::default()),
            ToolCall {
                id: "unread".into(),
                name: "artifact".into(),
                index: 0,
                arguments: json!({"action":"create","format":"docx","spec":{"blocks":[]}}),
            },
        )
        .await;
        assert_eq!(result.code.as_deref(), Some("skill_read_required"));
        let mut types = Vec::new();
        while let Ok(event) = events.try_recv() {
            types.push(event["type"].as_str().unwrap().to_owned());
        }
        assert_eq!(
            types
                .iter()
                .filter(|kind| *kind == "tool.requested")
                .count(),
            1
        );
        assert_eq!(
            types.iter().filter(|kind| *kind == "tool.finished").count(),
            1
        );
        assert!(
            !types
                .iter()
                .any(|kind| kind == "artifact.requested" || kind == "permission.requested")
        );
        assert!(!directory.path().join("artifacts").exists());
    }
}
