use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock, broadcast};
use uuid::Uuid;

use crate::{
    config::{RunnerConfig, load_runner_config},
    context::{ContextCalibration, SessionContextStore, SystemPromptSize, UsageAnchor},
    conversation_state::ConversationState,
    diagnostics::RunnerDiagnostics,
    events::RunnerEvent,
    lsp::LspService,
    permission::PermissionBroker,
    run_queue::RunQueue,
    skill_preflight::SharedSkillCache,
    tools::{SearchIndex, ToolSurface},
    workspace_graph::WorkspaceGraphService,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputPart {
    Text { text: String },
    Image { data_url: String },
}

#[derive(Clone)]
pub struct EventSink {
    sender: broadcast::Sender<RunnerEvent>,
    diagnostics: Arc<RunnerDiagnostics>,
}

impl EventSink {
    pub fn emit(&self, event: RunnerEvent) {
        self.diagnostics.record(&event);
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RunnerEvent> {
        self.sender.subscribe()
    }
}

pub struct Session {
    pub id: String,
    pub task_id: String,
    pub config: Arc<RunnerConfig>,
    pub messages: Mutex<Vec<Value>>,
    pub durable_summary: Mutex<Option<String>>,
    pub failed_compaction_digest: Mutex<Option<String>>,
    pub compaction_count: AtomicU32,
    /// Consecutive semantic compactions that a later *measured* prompt size
    /// proved did not get the context below the trigger.
    pub compaction_strikes: AtomicU32,
    /// Consecutive summarization round-trips that errored or came back
    /// unusable. `failed_compaction_digest` only refuses the *identical* prefix,
    /// so without this a conversation that keeps growing presents a new digest
    /// every turn and retries a failing call forever, each retry a full model
    /// round-trip. Cleared by any successful compaction.
    pub compaction_failures: AtomicU32,
    /// Set when a compaction invalidated the anchor. While set, a merely
    /// heuristic estimate may not re-trigger semantic compaction, so a
    /// pessimistic guess cannot compact twice before the next measurement.
    pub awaiting_observed_usage: AtomicBool,
    pub context_calibration: Mutex<Option<ContextCalibration>>,
    /// The last response's measured prompt size, anchoring every estimate until
    /// the settled prefix is mutated.
    pub usage_anchor: Mutex<Option<UsageAnchor>>,
    /// Veil's measurement of the protected prefix it owns and the runner never
    /// sees. Stable for the session unless the route or skill catalog changes.
    pub system_prompt_size: Mutex<Option<SystemPromptSize>>,
    pub context_store: Mutex<SessionContextStore>,
    pub lsp: Option<LspService>,
    pub workspace_graph: Option<WorkspaceGraphService>,
    pub skill_cache: SharedSkillCache,
    /// Warm workspace path index behind `search`. Lives for the session and is
    /// marked stale at the start of every accepted run, so between-turn editor
    /// changes are observed without a filesystem watcher.
    pub search_index: Arc<SearchIndex>,
    /// The last valid orient bucket for this session. A continuity hint only,
    /// for referential follow-ups such as "yes, draft it". It is cleared on any
    /// orient failure so a stale playbook can never be reused.
    /// The tool contract presented to the model, frozen on first use and reused
    /// for every step of the task.
    pub(crate) tool_surface: OnceLock<Arc<ToolSurface>>,
    /// At most one in-flight run per session. Abort is scoped to the active run id.
    pub(crate) run: std::sync::Mutex<Option<ActiveRun>>,
    pub queue: Mutex<RunQueue>,
}

pub(crate) struct ActiveRun {
    id: String,
    aborted: AtomicBool,
}

/// RAII handle that clears the active run when the owning prompt task ends.
pub struct RunGuard {
    session: Arc<Session>,
    run_id: String,
}

impl RunGuard {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.session.end_run(&self.run_id);
    }
}

impl Session {
    pub fn try_begin_run(self: &Arc<Self>) -> Result<RunGuard, &'static str> {
        let mut run = self
            .run
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if run.is_some() {
            return Err("run_in_progress");
        }
        let run_id = format!("run-{}", Uuid::new_v4());
        *run = Some(ActiveRun {
            id: run_id.clone(),
            aborted: AtomicBool::new(false),
        });
        Ok(RunGuard {
            session: Arc::clone(self),
            run_id,
        })
    }

    fn end_run(&self, run_id: &str) {
        let mut run = self
            .run
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if run.as_ref().is_some_and(|active| active.id == run_id) {
            *run = None;
        }
    }

    pub fn active_run_id(&self) -> Option<String> {
        self.run
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|active| active.id.clone())
    }

    pub fn abort(&self) {
        if let Some(active) = self
            .run
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            active.aborted.store(true, Ordering::SeqCst);
        }
    }

    pub fn is_aborted(&self) -> bool {
        self.run
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .is_some_and(|active| active.aborted.load(Ordering::SeqCst))
    }
}

pub struct SessionStore {
    pub config: Arc<RunnerConfig>,
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    pub sink: EventSink,
    pub permissions: Arc<PermissionBroker>,
}

impl SessionStore {
    pub fn new() -> Result<Arc<Self>, String> {
        Ok(Self::from_config(load_runner_config()?))
    }

    pub(crate) fn from_config(config: RunnerConfig) -> Arc<Self> {
        let config = Arc::new(config);
        let diagnostics = Arc::new(RunnerDiagnostics::new(
            config.diagnostics.clone(),
            &config.cwd,
            config.task_id.as_deref(),
        ));
        let (sender, _) = broadcast::channel(512);
        Arc::new(Self {
            config,
            sessions: RwLock::new(HashMap::new()),
            sink: EventSink {
                sender,
                diagnostics,
            },
            permissions: Arc::new(PermissionBroker::default()),
        })
    }

    pub async fn create(
        &self,
        conversation_state: Option<ConversationState>,
    ) -> Result<Arc<Session>, String> {
        let conversation_state = conversation_state
            .map(ConversationState::validate)
            .transpose()?;
        let id = format!("session-{}", Uuid::new_v4());
        let task_id = self.config.task_id.clone().unwrap_or_else(|| id.clone());
        let workspace_graph = self.config.workspace_graph.as_ref().map(|graph| {
            WorkspaceGraphService::new(self.config.cwd.clone(), graph.artifact_path.clone())
        });
        let lsp = (!self.config.lsp_servers.is_empty())
            .then(|| LspService::new(self.config.cwd.clone(), self.config.lsp_servers.clone()));
        let messages = conversation_state
            .as_ref()
            .map(ConversationState::seeded_messages)
            .unwrap_or_default();
        let durable_summary = conversation_state.and_then(|state| state.summary);
        let session = Arc::new(Session {
            id: id.clone(),
            task_id,
            config: self.config.clone(),
            messages: Mutex::new(messages),
            durable_summary: Mutex::new(durable_summary),
            failed_compaction_digest: Mutex::new(None),
            compaction_count: AtomicU32::new(0),
            compaction_strikes: AtomicU32::new(0),
            compaction_failures: AtomicU32::new(0),
            // A seeded session starts from a summary plus a tail, which no
            // past measurement describes, so it starts unanchored exactly like
            // a session whose prefix was just compacted.
            awaiting_observed_usage: AtomicBool::new(false),
            context_calibration: Mutex::new(None),
            usage_anchor: Mutex::new(None),
            system_prompt_size: Mutex::new(None),
            context_store: Mutex::new(SessionContextStore::default()),
            lsp,
            workspace_graph,
            skill_cache: SharedSkillCache::default(),
            search_index: Arc::new(SearchIndex::default()),
            tool_surface: OnceLock::new(),
            run: std::sync::Mutex::new(None),
            queue: Mutex::new(RunQueue::default()),
        });
        self.sessions.write().await.insert(id, session.clone());
        Ok(session)
    }

    pub async fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| "Session not found".to_owned())
    }

    pub async fn abort(&self, id: &str) -> Result<(), String> {
        let session = self.get(id).await?;
        session.abort();
        self.permissions.abort_all(&self.sink, &session.task_id);
        Ok(())
    }

    pub async fn shutdown(&self) {
        let sessions = self
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            if let Some(lsp) = session.lsp.as_ref() {
                lsp.shutdown().await;
            }
        }
    }

    pub fn diagnostic_metadata(&self) -> Value {
        serde_json::to_value(self.sink.diagnostics.metadata())
            .unwrap_or_else(|_| json!({ "enabled": false }))
    }
}

#[cfg(test)]
pub(crate) fn test_config(cwd: &std::path::Path) -> Arc<RunnerConfig> {
    Arc::new(RunnerConfig {
        password: "test-password".into(),
        task_id: Some("test-task".into()),
        cwd: cwd.to_path_buf(),
        context_length: 64_000,
        max_response_tokens: 4_096,
        protected_prompt_reserve_tokens: 4_096,
        attachment_directory: None,
        skills: Vec::new(),
        permission_mode: crate::config::PermissionMode::AutoSafe,
        enabled_tools: crate::config::RUNNER_TOOL_NAMES
            .iter()
            .map(|name| (*name).to_owned())
            .collect(),
        approved_executables: std::collections::BTreeMap::new(),
        lsp_servers: Vec::new(),
        workspace_graph: None,
        diagnostics: crate::config::DiagnosticsConfig {
            enabled: false,
            log_path: None,
            directory: None,
            include_tool_output: "none".into(),
        },
        provider: crate::config::ProviderConfig {
            id: "company-endpoint".into(),
            name: "Test Veil".into(),
            base_url: "http://127.0.0.1:1".into(),
            mode: crate::config::ProviderMode::Local,
            chat_endpoint_path: Some("/api/engineering/chat".into()),
            api_key: Arc::new(std::sync::RwLock::new(String::new())),
            model_id: "test".into(),
            headers: std::collections::BTreeMap::new(),
            mtls: None,
        },
    })
}

#[cfg(test)]
pub(crate) fn test_sink(cwd: &std::path::Path) -> EventSink {
    let config = crate::config::DiagnosticsConfig {
        enabled: false,
        log_path: None,
        directory: None,
        include_tool_output: "none".into(),
    };
    let (sender, _) = broadcast::channel(128);
    EventSink {
        sender,
        diagnostics: Arc::new(RunnerDiagnostics::new(config, cwd, Some("test-task"))),
    }
}

#[cfg(test)]
pub(crate) fn test_session(cwd: &std::path::Path) -> Arc<Session> {
    Arc::new(Session {
        id: "test-session".into(),
        task_id: "test-task".into(),
        config: test_config(cwd),
        messages: Mutex::new(Vec::new()),
        durable_summary: Mutex::new(None),
        failed_compaction_digest: Mutex::new(None),
        compaction_count: AtomicU32::new(0),
        compaction_strikes: AtomicU32::new(0),
        compaction_failures: AtomicU32::new(0),
        awaiting_observed_usage: AtomicBool::new(false),
        context_calibration: Mutex::new(None),
        usage_anchor: Mutex::new(None),
        system_prompt_size: Mutex::new(None),
        context_store: Mutex::new(SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: SharedSkillCache::default(),
        search_index: Arc::new(SearchIndex::default()),
        tool_surface: OnceLock::new(),
        run: std::sync::Mutex::new(None),
        queue: Mutex::new(RunQueue::default()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abort_state_is_scoped_to_the_active_run_and_sessions_are_independent() {
        let directory = tempfile::tempdir().unwrap();
        let first = test_session(directory.path());
        let second = test_session(directory.path());
        let first_run = first.try_begin_run().expect("first run");
        let _second_run = second.try_begin_run().expect("second session run");
        first.abort();
        assert!(first.is_aborted());
        assert!(!second.is_aborted());
        drop(first_run);
        assert!(!first.is_aborted());
        let next = first.try_begin_run().expect("next run after prior ends");
        assert!(!first.is_aborted());
        assert!(next.run_id().starts_with("run-"));
    }

    #[test]
    fn second_begin_run_is_rejected_while_a_run_is_active() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        let _active = session.try_begin_run().expect("first run");
        assert_eq!(session.try_begin_run().err(), Some("run_in_progress"));
        session.abort();
        assert!(session.is_aborted());
        // A second begin must still fail; abort must not clear the active run.
        assert_eq!(session.try_begin_run().err(), Some("run_in_progress"));
    }
}
