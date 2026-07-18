use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock, broadcast};
use uuid::Uuid;

use crate::{
    config::{RunnerConfig, load_runner_config},
    context::SessionContextStore,
    diagnostics::RunnerDiagnostics,
    events::RunnerEvent,
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
    pub context_store: Mutex<SessionContextStore>,
    pub workspace_graph: Option<WorkspaceGraphService>,
    pub aborted: AtomicBool,
}

impl Session {
    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
    }
    pub fn reset_abort(&self) {
        self.aborted.store(false, Ordering::SeqCst);
    }
    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
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

    pub async fn create(&self) -> Arc<Session> {
        let id = format!("session-{}", Uuid::new_v4());
        let task_id = self.config.task_id.clone().unwrap_or_else(|| id.clone());
        let workspace_graph = self.config.workspace_graph.as_ref().map(|graph| {
            WorkspaceGraphService::new(self.config.cwd.clone(), graph.artifact_path.clone())
        });
        let session = Arc::new(Session {
            id: id.clone(),
            task_id,
            config: self.config.clone(),
            messages: Mutex::new(Vec::new()),
            context_store: Mutex::new(SessionContextStore::default()),
            workspace_graph,
            aborted: AtomicBool::new(false),
        });
        self.sessions.write().await.insert(id, session.clone());
        session
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
        model_boundary: crate::config::ModelBoundary::Managed,
        skills: Vec::new(),
        permission_mode: crate::config::PermissionMode::Bypass,
        enabled_tools: crate::config::RUNNER_TOOL_NAMES
            .iter()
            .map(|name| (*name).to_owned())
            .collect(),
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
        context_store: Mutex::new(SessionContextStore::default()),
        workspace_graph: None,
        aborted: AtomicBool::new(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abort_state_is_local_to_each_session_and_can_be_reset() {
        let directory = tempfile::tempdir().unwrap();
        let first = test_session(directory.path());
        let second = test_session(directory.path());
        first.abort();
        assert!(first.is_aborted());
        assert!(!second.is_aborted());
        first.reset_abort();
        assert!(!first.is_aborted());
    }
}
