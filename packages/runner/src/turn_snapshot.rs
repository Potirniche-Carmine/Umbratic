//! The immutable inputs to one provider request.
//!
//! Invariant 2 says the turn snapshot cannot change while a provider request is
//! in flight. Rather than relying on control flow to honor that, everything the
//! request depends on is captured once, up front, into an owned value.
//!
//! "Everything the request depends on" is what the request actually reads. The
//! snapshot used to also carry the route, model id, context length, capability
//! flags, a skill-catalog hash, and a per-request SHA-256 of the messages —
//! none of which anything ever read back. Fields no caller consults do not
//! freeze anything; they only made the type look like it guaranteed more than
//! it did, and cost a hash of the whole prompt on every request.
//!
//! Deferred changes (invariant 7) therefore apply only between snapshots: a
//! model, skill, or queued-input change that lands mid-request cannot reach the
//! request already on the wire.

use std::sync::Arc;

use serde_json::Value;

use crate::tools::ToolSurface;

#[derive(Debug)]
pub struct TurnSnapshot {
    messages: Vec<Value>,
    tools: Vec<Value>,
    max_output_tokens: u64,
    /// The active run's validated bucket selector, if orient produced a guided
    /// decision. It changes the request, so the snapshot owns it. It is a
    /// selector only: the playbook bytes are Veil-owned and never hashed here.
    harness_bucket: Option<String>,
}

impl TurnSnapshot {
    pub fn new(
        surface: Arc<ToolSurface>,
        messages: Vec<Value>,
        max_output_tokens: u64,
        harness_bucket: Option<String>,
    ) -> Self {
        Self {
            tools: surface.specs().to_vec(),
            messages,
            max_output_tokens,
            harness_bucket,
        }
    }

    /// The validated bucket selector for every normal request and retry in this
    /// run. `None` for direct answers and every degraded run.
    pub fn harness_bucket(&self) -> Option<&str> {
        self.harness_bucket.as_deref()
    }

    pub fn messages(&self) -> &[Value] {
        &self.messages
    }

    pub fn tools(&self) -> &[Value] {
        &self.tools
    }

    pub fn max_output_tokens(&self) -> u64 {
        self.max_output_tokens
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn a_snapshot_is_immutable_while_its_request_is_in_flight() {
        // Invariant 2: deferred changes apply only between snapshots. Mutating
        // every input the turn was built from must not alter the in-flight turn.
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        let surface = crate::tools::tool_surface(&session);
        let snapshot = TurnSnapshot::new(
            surface,
            vec![json!({"role": "user", "content": "original request"})],
            4_096,
            Some("code_change".into()),
        );
        let before_messages = snapshot.messages().to_vec();
        let before_tools = snapshot.tools().to_vec();
        let before_budget = snapshot.max_output_tokens();
        let before_bucket = snapshot.harness_bucket().map(str::to_owned);
        assert!(!before_tools.is_empty(), "the turn must declare its tools");

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
        assert_eq!(snapshot.max_output_tokens(), before_budget);
        assert_eq!(snapshot.harness_bucket().map(str::to_owned), before_bucket);
    }
}
