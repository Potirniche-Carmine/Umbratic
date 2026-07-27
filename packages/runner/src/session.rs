use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock, broadcast};
use uuid::Uuid;

use crate::{
    config::{RunnerConfig, load_runner_config},
    context::{ContextCalibration, SessionContextStore},
    context_state::ContextStateV1,
    diagnostics::RunnerDiagnostics,
    events::RunnerEvent,
    lsp::LspService,
    permission::PermissionBroker,
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
    pub context_calibration: Mutex<Option<ContextCalibration>>,
    pub context_store: Mutex<SessionContextStore>,
    pub lsp: Option<LspService>,
    pub workspace_graph: Option<WorkspaceGraphService>,
    /// At most one in-flight turn per session. Abort is scoped to the active turn id.
    pub(crate) turn: std::sync::Mutex<Option<ActiveTurn>>,
}

pub(crate) struct ActiveTurn {
    id: String,
    aborted: AtomicBool,
}

/// RAII handle that clears the active turn when the owning prompt task ends.
pub struct TurnGuard {
    session: Arc<Session>,
    turn_id: String,
}

impl TurnGuard {
    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.session.end_turn(&self.turn_id);
    }
}

impl Session {
    pub fn try_begin_turn(self: &Arc<Self>) -> Result<TurnGuard, &'static str> {
        let mut turn = self
            .turn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if turn.is_some() {
            return Err("turn_in_progress");
        }
        let turn_id = format!("turn-{}", Uuid::new_v4());
        *turn = Some(ActiveTurn {
            id: turn_id.clone(),
            aborted: AtomicBool::new(false),
        });
        Ok(TurnGuard {
            session: Arc::clone(self),
            turn_id,
        })
    }

    fn end_turn(&self, turn_id: &str) {
        let mut turn = self
            .turn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if turn.as_ref().is_some_and(|active| active.id == turn_id) {
            *turn = None;
        }
    }

    pub fn abort(&self) {
        if let Some(active) = self
            .turn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            active.aborted.store(true, Ordering::SeqCst);
        }
    }

    pub fn is_aborted(&self) -> bool {
        self.turn
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
        let config = Arc::new(load_runner_config()?);
        let diagnostics = Arc::new(RunnerDiagnostics::new(
            config.diagnostics.clone(),
            &config.cwd,
            config.task_id.as_deref(),
        ));
        let (sender, _) = broadcast::channel(512);
        Ok(Arc::new(Self {
            config,
            sessions: RwLock::new(HashMap::new()),
            sink: EventSink {
                sender,
                diagnostics,
            },
            permissions: Arc::new(PermissionBroker::default()),
        }))
    }

    pub async fn create(
        &self,
        context_state: Option<ContextStateV1>,
    ) -> Result<Arc<Session>, String> {
        let context_state = context_state.map(ContextStateV1::validate).transpose()?;
        let id = format!("session-{}", Uuid::new_v4());
        let task_id = self.config.task_id.clone().unwrap_or_else(|| id.clone());
        let workspace_graph = self.config.workspace_graph.as_ref().map(|graph| {
            WorkspaceGraphService::new(self.config.cwd.clone(), graph.artifact_path.clone())
        });
        let lsp = (!self.config.lsp_servers.is_empty())
            .then(|| LspService::new(self.config.cwd.clone(), self.config.lsp_servers.clone()));
        let messages = context_state
            .as_ref()
            .map(ContextStateV1::seeded_messages)
            .unwrap_or_default();
        let durable_summary = context_state.and_then(|state| state.summary);
        let session = Arc::new(Session {
            id: id.clone(),
            task_id,
            config: self.config.clone(),
            messages: Mutex::new(messages),
            durable_summary: Mutex::new(durable_summary),
            failed_compaction_digest: Mutex::new(None),
            compaction_count: AtomicU32::new(0),
            context_calibration: Mutex::new(None),
            context_store: Mutex::new(SessionContextStore::default()),
            lsp,
            workspace_graph,
            turn: std::sync::Mutex::new(None),
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
        self.permissions.deny_all(&self.sink, &session.task_id);
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
        task_id: Some("test-task".into()),
        cwd: cwd.to_path_buf(),
        context_length: 64_000,
        max_response_tokens: 4_096,
        protected_prompt_reserve_tokens: 4_096,
        attachment_directory: None,
        workspace_mode: "local".into(),
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
            chat_endpoint_path: Some("/api/engineering/chat".into()),
            api_key: String::new(),
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
        context_calibration: Mutex::new(None),
        context_store: Mutex::new(SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        turn: std::sync::Mutex::new(None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abort_state_is_scoped_to_the_active_turn_and_sessions_are_independent() {
        let directory = tempfile::tempdir().unwrap();
        let first = test_session(directory.path());
        let second = test_session(directory.path());
        let first_turn = first.try_begin_turn().expect("first turn");
        let _second_turn = second.try_begin_turn().expect("second session turn");
        first.abort();
        assert!(first.is_aborted());
        assert!(!second.is_aborted());
        drop(first_turn);
        assert!(!first.is_aborted());
        let next = first.try_begin_turn().expect("next turn after prior ends");
        assert!(!first.is_aborted());
        assert!(next.turn_id().starts_with("turn-"));
    }

    #[test]
    fn second_begin_turn_is_rejected_while_a_turn_is_active() {
        let directory = tempfile::tempdir().unwrap();
        let session = test_session(directory.path());
        let _active = session.try_begin_turn().expect("first turn");
        assert_eq!(session.try_begin_turn().err(), Some("turn_in_progress"));
        session.abort();
        assert!(session.is_aborted());
        // A second begin must still fail; abort must not clear the active turn.
        assert_eq!(session.try_begin_turn().err(), Some("turn_in_progress"));
    }
}
