use std::fs;

use crate::session::Session;

const MAX_SKILL_BYTES: u64 = 512 * 1024;

pub(crate) fn explicit_skill_context(
    session: &Session,
    text: &str,
) -> Vec<(String, String, String)> {
    session
        .config
        .skills
        .iter()
        .filter(|skill| explicit_skill_mention(text, &skill.id))
        .filter_map(|skill| {
            read_skill_text(&skill.instruction_path)
                .ok()
                .map(|content| (skill.id.clone(), skill.source.clone(), content))
        })
        .collect()
}

pub(super) fn explicit_skill_mention(text: &str, skill_id: &str) -> bool {
    let needle = format!("${skill_id}");
    text.match_indices(&needle).any(|(start, _)| {
        let before = text[..start].chars().next_back();
        let after = text[start + needle.len()..].chars().next();
        before.is_none_or(|value| !value.is_ascii_alphanumeric() && value != '_' && value != '-')
            && after
                .is_none_or(|value| !value.is_ascii_alphanumeric() && value != '_' && value != '-')
    })
}

fn read_skill_text(path: &std::path::Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_SKILL_BYTES {
        return Err("Skill instructions are not a bounded file".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.contains(&0) {
        return Err("Skill instructions are binary".into());
    }
    String::from_utf8(bytes).map_err(|_| "Skill instructions are not UTF-8".into())
}
