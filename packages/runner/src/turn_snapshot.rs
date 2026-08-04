//! The immutable inputs to one provider request.
//!
//! Invariant 2 says the turn snapshot cannot change while a provider request is
//! in flight. Rather than relying on control flow to honor that, everything the
//! request depends on is captured once, up front, into an owned value: prompt
//! assembly, route, model profile, skill catalog, the frozen tool contract,
//! capabilities, the settled conversation state it was built from, and the
//! recomputed token budget.
//!
//! Deferred changes (invariant 7) therefore apply only between snapshots: a
//! model, skill, or queued-input change that lands mid-request cannot reach the
//! request already on the wire.

use std::sync::Arc;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{session::Session, tools::ToolSurface};

#[derive(Debug)]
pub struct TurnSnapshot {
    messages: Vec<Value>,
    tools: Vec<Value>,
    surface: Arc<ToolSurface>,
    route: String,
    model_id: String,
    max_output_tokens: u64,
    context_length: u64,
    skill_catalog_hash: String,
    conversation_digest: String,
    capabilities: Capabilities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub lsp: bool,
    pub workspace_graph: bool,
    pub parallel_tool_calls: bool,
}

impl TurnSnapshot {
    pub fn new(
        session: &Session,
        surface: Arc<ToolSurface>,
        messages: Vec<Value>,
        max_output_tokens: u64,
        skills: &[Value],
        route: String,
    ) -> Self {
        let conversation_digest = digest_of(&messages);
        Self {
            tools: surface.specs().to_vec(),
            surface,
            messages,
            route,
            model_id: session.config.provider.model_id.clone(),
            max_output_tokens,
            context_length: session.config.context_length,
            skill_catalog_hash: skill_catalog_hash(skills),
            conversation_digest,
            capabilities: Capabilities {
                lsp: session.lsp.is_some(),
                workspace_graph: session.workspace_graph.is_some(),
                parallel_tool_calls: session.config.provider.parallel_tool_calls,
            },
        }
    }

    pub fn messages(&self) -> &[Value] {
        &self.messages
    }

    pub fn tools(&self) -> &[Value] {
        &self.tools
    }

    pub fn surface(&self) -> &ToolSurface {
        &self.surface
    }

    pub fn max_output_tokens(&self) -> u64 {
        self.max_output_tokens
    }

    pub fn route(&self) -> &str {
        &self.route
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    pub fn context_length(&self) -> u64 {
        self.context_length
    }

    pub fn skill_catalog_hash(&self) -> &str {
        &self.skill_catalog_hash
    }

    /// Identifies the conversation state this snapshot was built from. It is a
    /// content hash, not a version: it names bytes and gates nothing.
    pub fn conversation_digest(&self) -> &str {
        &self.conversation_digest
    }

    pub fn capabilities(&self) -> Capabilities {
        self.capabilities
    }
}

fn digest_of(messages: &[Value]) -> String {
    let encoded = serde_json::to_string(messages).unwrap_or_default();
    format!("{:x}", Sha256::digest(encoded.as_bytes()))
}

fn skill_catalog_hash(skills: &[Value]) -> String {
    let encoded = serde_json::to_string(skills).unwrap_or_default();
    format!("{:x}", Sha256::digest(encoded.as_bytes()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn snapshot_for(directory: &std::path::Path) -> (Arc<Session>, TurnSnapshot) {
        let session = crate::session::test_session(directory);
        let surface = crate::tools::tool_surface(&session);
        let snapshot = TurnSnapshot::new(
            &session,
            surface,
            vec![json!({"role": "user", "content": "original request"})],
            4_096,
            &[json!({"id": "python"})],
            "/api/engineering/chat".into(),
        );
        (session, snapshot)
    }

    #[tokio::test]
    async fn a_snapshot_is_immutable_while_its_request_is_in_flight() {
        // Invariant 2: deferred changes apply only between snapshots. Mutating
        // every input the turn was built from must not alter the in-flight turn.
        let directory = tempfile::tempdir().unwrap();
        let (session, snapshot) = snapshot_for(directory.path());
        let before_messages = snapshot.messages().to_vec();
        let before_tools = snapshot.tools().to_vec();
        let before_digest = snapshot.conversation_digest().to_owned();
        let before_skills = snapshot.skill_catalog_hash().to_owned();
        let before_budget = snapshot.max_output_tokens();

        // Queued input landing mid-request.
        session
            .messages
            .lock()
            .await
            .push(json!({"role": "user", "content": "steer that arrived mid-request"}));
        // Context store growth, which used to change the declared tool surface.
        session
            .context_store
            .lock()
            .await
            .store(
                "call-1",
                "command",
                "output",
                &"x".repeat(32 * 1024),
                "compressed",
                "log",
                "text_head_tail",
            )
            .unwrap();

        assert_eq!(snapshot.messages(), before_messages.as_slice());
        assert_eq!(snapshot.tools(), before_tools.as_slice());
        assert_eq!(snapshot.conversation_digest(), before_digest);
        assert_eq!(snapshot.skill_catalog_hash(), before_skills);
        assert_eq!(snapshot.max_output_tokens(), before_budget);
    }

    #[tokio::test]
    async fn a_snapshot_records_the_route_profile_and_capabilities_it_used() {
        let directory = tempfile::tempdir().unwrap();
        let (session, snapshot) = snapshot_for(directory.path());
        assert_eq!(snapshot.route(), "/api/engineering/chat");
        assert_eq!(snapshot.model_id(), session.config.provider.model_id);
        assert_eq!(snapshot.context_length(), session.config.context_length);
        assert_eq!(snapshot.capabilities().lsp, session.lsp.is_some());
        assert_eq!(snapshot.conversation_digest().len(), 64);
        assert!(snapshot.surface().declares("read"));
    }
}
