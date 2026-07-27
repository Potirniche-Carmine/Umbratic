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
