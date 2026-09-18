use std::{collections::HashMap, fs, path::Path, sync::Mutex};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    config::RunnerSkillConfig,
    events::now_iso,
    policy::redact_text,
    session::{EventSink, Session},
};

const MAX_SKILL_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone)]
pub struct CachedSkill {
    pub skill_id: String,
    pub source: String,
    pub content: String,
    pub content_hash: String,
    pub bytes: usize,
}

#[derive(Debug, Default)]
pub struct SkillCache {
    by_skill_id: HashMap<String, CachedSkill>,
}

impl SkillCache {
    pub fn get_by_skill_id(&self, skill_id: &str) -> Option<&CachedSkill> {
        self.by_skill_id.get(skill_id)
    }

    pub fn insert(&mut self, skill: CachedSkill) {
        self.by_skill_id.insert(skill.skill_id.clone(), skill);
    }
}

#[derive(Debug)]
pub struct SkillLoadFailure {
    pub code: &'static str,
    pub message: String,
}

pub fn parse_selected_skill_ids(body: &serde_json::Map<String, Value>) -> Vec<String> {
    body.get("selectedSkillIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn collect_selected_skill_ids(
    session: &Session,
    prompt_text: &str,
    selected_skill_ids: &[String],
) -> Vec<String> {
    let mut ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for skill_id in selected_skill_ids {
        if seen.insert(skill_id.clone()) {
            ids.push(skill_id.clone());
        }
    }
    for skill in &session.config.skills {
        if explicit_skill_mention(prompt_text, &skill.id) && seen.insert(skill.id.clone()) {
            ids.push(skill.id.clone());
        }
    }
    ids
}

pub fn explicit_skill_mention(text: &str, skill_id: &str) -> bool {
    let needle = format!("${skill_id}");
    text.match_indices(&needle).any(|(start, _)| {
        let before = text[..start].chars().next_back();
        let after = text[start + needle.len()..].chars().next();
        before.is_none_or(|value| !value.is_ascii_alphanumeric() && value != '_' && value != '-')
            && after
                .is_none_or(|value| !value.is_ascii_alphanumeric() && value != '_' && value != '-')
    })
}

pub fn run_harness_skill_preflight(
    session: &Session,
    run_id: &str,
    selected_ids: &[String],
    sink: &EventSink,
) -> Result<Vec<CachedSkill>, String> {
    let mut loaded = Vec::new();
    for skill_id in selected_ids {
        match load_skill_with_lifecycle(session, run_id, skill_id, "harness", sink) {
            Ok(skill) => loaded.push(skill),
            Err(failure) => {
                return Err(format!(
                    "Explicit skill load failed ({}): {}",
                    failure.code, failure.message
                ));
            }
        }
    }
    Ok(loaded)
}

pub fn load_skill_with_lifecycle(
    session: &Session,
    run_id: &str,
    skill_id: &str,
    origin: &str,
    sink: &EventSink,
) -> Result<CachedSkill, SkillLoadFailure> {
    let request_id = format!("skill-req-{}", Uuid::new_v4());
    let catalog = session
        .config
        .skills
        .iter()
        .find(|skill| skill.id == skill_id);
    let source = catalog
        .map(|skill| skill.source.as_str())
        .unwrap_or("unknown");
    let identity = SkillEventIdentity {
        task_id: &session.task_id,
        session_id: &session.id,
        run_id,
        request_id: &request_id,
        skill_id,
        source,
        origin,
    };
    emit_skill_requested(sink, &identity);
    let Some(skill) = catalog else {
        let failure = SkillLoadFailure {
            code: "skill_not_enabled",
            message: format!("Skill {skill_id} is not enabled."),
        };
        emit_skill_failed(sink, &identity, failure.code, &failure.message);
        return Err(failure);
    };
    match load_or_cache_skill(session, skill) {
        Ok(cached) => {
            emit_skill_loaded(sink, &identity, &cached);
            Ok(cached)
        }
        Err(failure) => {
            emit_skill_failed(sink, &identity, failure.code, &failure.message);
            Err(failure)
        }
    }
}

pub fn load_or_cache_skill(
    session: &Session,
    skill: &RunnerSkillConfig,
) -> Result<CachedSkill, SkillLoadFailure> {
    let content = read_skill_markdown(&skill.instruction_path)?;
    let content_hash = content_hash(&content);
    let cached = CachedSkill {
        skill_id: skill.id.clone(),
        source: skill.source.clone(),
        bytes: content.len(),
        content,
        content_hash,
    };
    let mut cache = session
        .skill_cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(existing) = cache.get_by_skill_id(&skill.id)
        && existing.content_hash == cached.content_hash
    {
        return Ok(existing.clone());
    }
    cache.insert(cached.clone());
    Ok(cached)
}

pub fn read_skill_markdown(path: &Path) -> Result<String, SkillLoadFailure> {
    let metadata = fs::metadata(path).map_err(|error| SkillLoadFailure {
        code: "skill_unreadable",
        message: redact_text(&error.to_string(), 200),
    })?;
    if !metadata.is_file() {
        return Err(SkillLoadFailure {
            code: "skill_unreadable",
            message: "Skill instructions are not a file.".into(),
        });
    }
    if metadata.len() > MAX_SKILL_BYTES {
        return Err(SkillLoadFailure {
            code: "skill_too_large",
            message: "Skill instructions exceed the bounded size limit.".into(),
        });
    }
    let bytes = fs::read(path).map_err(|error| SkillLoadFailure {
        code: "skill_unreadable",
        message: redact_text(&error.to_string(), 200),
    })?;
    if bytes.contains(&0) {
        return Err(SkillLoadFailure {
            code: "skill_binary",
            message: "Skill instructions are binary.".into(),
        });
    }
    String::from_utf8(bytes).map_err(|_| SkillLoadFailure {
        code: "skill_not_utf8",
        message: "Skill instructions are not UTF-8.".into(),
    })
}

pub fn harness_skill_context_message(skill: &CachedSkill) -> Value {
    json!({
        "role": "user",
        "content": format!(
            "Explicitly selected skill {}. Follow these complete task-specific instructions when they apply to the request:\n\n{}",
            skill.skill_id,
            skill.content
        )
    })
}

fn content_hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

struct SkillEventIdentity<'a> {
    task_id: &'a str,
    session_id: &'a str,
    run_id: &'a str,
    request_id: &'a str,
    skill_id: &'a str,
    source: &'a str,
    origin: &'a str,
}

fn emit_skill_requested(sink: &EventSink, identity: &SkillEventIdentity<'_>) {
    sink.emit(json!({
        "type": "skill.requested",
        "taskId": identity.task_id,
        "sessionId": identity.session_id,
        "runId": identity.run_id,
        "requestId": identity.request_id,
        "skillId": identity.skill_id,
        "source": identity.source,
        "origin": identity.origin,
        "at": now_iso()
    }));
}

fn emit_skill_loaded(sink: &EventSink, identity: &SkillEventIdentity<'_>, skill: &CachedSkill) {
    sink.emit(json!({
        "type": "skill.loaded",
        "taskId": identity.task_id,
        "sessionId": identity.session_id,
        "runId": identity.run_id,
        "requestId": identity.request_id,
        "skillId": skill.skill_id,
        "source": skill.source,
        "origin": identity.origin,
        "contentHash": skill.content_hash,
        "bytes": skill.bytes,
        "at": now_iso()
    }));
}

fn emit_skill_failed(
    sink: &EventSink,
    identity: &SkillEventIdentity<'_>,
    code: &str,
    message: &str,
) {
    sink.emit(json!({
        "type": "skill.failed",
        "taskId": identity.task_id,
        "sessionId": identity.session_id,
        "runId": identity.run_id,
        "requestId": identity.request_id,
        "skillId": identity.skill_id,
        "source": identity.source,
        "origin": identity.origin,
        "code": code,
        "message": redact_text(message, 500),
        "at": now_iso()
    }));
}

pub type SharedSkillCache = Mutex<SkillCache>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{test_session, test_sink};
    use std::sync::Arc;

    #[test]
    fn mention_and_body_ids_merge_without_duplicates() {
        let directory = tempfile::tempdir().unwrap();
        let mut config = (*crate::session::test_config(directory.path())).clone();
        config.skills.push(crate::config::RunnerSkillConfig {
            id: "python".into(),
            name: "Python".into(),
            description: String::new(),
            source: "system".into(),
            instruction_path: directory.path().join("SKILL.md"),
            paths: Vec::new(),
        });
        let session = Arc::new(crate::session::Session {
            id: "session".into(),
            task_id: "task".into(),
            config: Arc::new(config),
            messages: tokio::sync::Mutex::new(Vec::new()),
            durable_summary: tokio::sync::Mutex::new(None),
            failed_compaction_digest: tokio::sync::Mutex::new(None),
            compaction_count: std::sync::atomic::AtomicU32::new(0),
            compaction_strikes: std::sync::atomic::AtomicU32::new(0),
            compaction_failures: std::sync::atomic::AtomicU32::new(0),
            awaiting_observed_usage: std::sync::atomic::AtomicBool::new(false),
            usage_anchor: tokio::sync::Mutex::new(None),
            system_prompt_size: tokio::sync::Mutex::new(None),
            context_calibration: tokio::sync::Mutex::new(None),
            context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
            lsp: None,
            workspace_graph: None,
            artifacts: Arc::new(crate::artifact::ArtifactBroker::default()),
            skill_cache: SharedSkillCache::default(),
            queue: tokio::sync::Mutex::new(crate::run_queue::RunQueue::default()),
            run: std::sync::Mutex::new(None),
            search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
            tool_surface: std::sync::OnceLock::new(),
        });
        let ids = collect_selected_skill_ids(
            &session,
            "Use $python please",
            &["python".into(), "missing".into()],
        );
        assert_eq!(ids, vec!["python".to_owned(), "missing".to_owned()]);
    }

    #[test]
    fn harness_preflight_emits_requested_then_failed_for_missing_skill() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        let sink = test_sink(directory.path());
        let mut events = sink.subscribe();
        let error =
            run_harness_skill_preflight(&session, "run-1", &["missing".into()], &sink).unwrap_err();
        assert!(error.contains("skill_not_enabled"));
        let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(observed[0]["type"], "skill.requested");
        assert_eq!(observed[0]["origin"], "harness");
        assert_eq!(observed[1]["type"], "skill.failed");
        assert_eq!(observed[1]["code"], "skill_not_enabled");
    }

    #[test]
    fn harness_preflight_refreshes_changed_content_without_conflating_skill_ids() {
        let directory = tempfile::tempdir().unwrap();
        let skill_path = directory.path().join("SKILL.md");
        std::fs::write(&skill_path, "skill body").unwrap();
        let mut config = (*crate::session::test_config(directory.path())).clone();
        config.skills.push(crate::config::RunnerSkillConfig {
            id: "demo".into(),
            name: "Demo".into(),
            description: String::new(),
            source: "local".into(),
            instruction_path: skill_path.clone(),
            paths: Vec::new(),
        });
        let session = Arc::new(crate::session::Session {
            id: "session".into(),
            task_id: "task".into(),
            config: Arc::new(config),
            messages: tokio::sync::Mutex::new(Vec::new()),
            durable_summary: tokio::sync::Mutex::new(None),
            failed_compaction_digest: tokio::sync::Mutex::new(None),
            compaction_count: std::sync::atomic::AtomicU32::new(0),
            compaction_strikes: std::sync::atomic::AtomicU32::new(0),
            compaction_failures: std::sync::atomic::AtomicU32::new(0),
            awaiting_observed_usage: std::sync::atomic::AtomicBool::new(false),
            usage_anchor: tokio::sync::Mutex::new(None),
            system_prompt_size: tokio::sync::Mutex::new(None),
            context_calibration: tokio::sync::Mutex::new(None),
            context_store: tokio::sync::Mutex::new(crate::context::SessionContextStore::default()),
            lsp: None,
            workspace_graph: None,
            artifacts: Arc::new(crate::artifact::ArtifactBroker::default()),
            skill_cache: SharedSkillCache::default(),
            queue: tokio::sync::Mutex::new(crate::run_queue::RunQueue::default()),
            run: std::sync::Mutex::new(None),
            search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
            tool_surface: std::sync::OnceLock::new(),
        });
        let sink = test_sink(directory.path());
        let first =
            run_harness_skill_preflight(&session, "run-1", &["demo".into()], &sink).unwrap();
        let second =
            run_harness_skill_preflight(&session, "run-2", &["demo".into()], &sink).unwrap();
        assert_eq!(first[0].content_hash, second[0].content_hash);
        assert_eq!(first[0].content, "skill body");
        let mut other = session.config.skills[0].clone();
        other.id = "other".into();
        other.source = "imported".into();
        let same_content = load_or_cache_skill(&session, &other).unwrap();
        assert_eq!(same_content.content_hash, first[0].content_hash);
        assert_eq!(same_content.skill_id, "other");
        assert_eq!(same_content.source, "imported");

        fs::write(&skill_path, "updated skill body").unwrap();
        let updated =
            run_harness_skill_preflight(&session, "run-3", &["demo".into()], &sink).unwrap();
        assert_ne!(updated[0].content_hash, first[0].content_hash);
        assert_eq!(updated[0].content, "updated skill body");
        fs::remove_file(&skill_path).unwrap();
        assert!(run_harness_skill_preflight(&session, "run-4", &["demo".into()], &sink).is_err());
    }
}
