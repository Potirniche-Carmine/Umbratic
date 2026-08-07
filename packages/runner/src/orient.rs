//! Hidden intent-bucket classification for one accepted run.
//!
//! Orient is a preflight, not a generation: it runs once per accepted run,
//! before the tool loop, and every step of that run reuses its decision. The
//! decision is broadcast as an `orient.decision` event so harness logs (runner
//! diagnostics and the desktop's local event log) can answer "which bucket
//! fired?"; the desktop records it as a diagnostic only and never renders it,
//! so the bucket id still never appears in chat output.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    events::now_iso,
    session::{EventSink, Session},
    veil_client::{DIRECT_ANSWER_BUCKET, orient_request},
};

/// What one accepted run carries away from orient.
#[derive(Debug, Clone, Default)]
pub(crate) struct OrientOutcome {
    /// The validated selector, or `None` for a direct answer and every degraded
    /// path.
    pub(crate) bucket: Option<String>,
    /// Whether this bucket's answer must rest on tool results. False whenever
    /// there is no bucket, so a degraded run is never held to the rule.
    pub(crate) evidence_required: bool,
}

impl OrientOutcome {
    pub(crate) fn bucket(&self) -> Option<&str> {
        self.bucket.as_deref()
    }
}

/// The assistant's most recent finished answer, or "" on the first turn.
///
/// This is what makes "yes, go ahead" classifiable without carrying a bucket
/// forward. Only real answers qualify: a preamble is stored as a tool-call
/// message with null content, so the scan naturally skips narration and lands
/// on the last thing the user actually read.
async fn latest_assistant_answer(session: &Session) -> String {
    session
        .messages
        .lock()
        .await
        .iter()
        .rev()
        .find(|message| {
            message.get("role").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| !content.trim().is_empty())
        })
        .and_then(|message| message.get("content").and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

/// Classifies the accepted run into a hidden intent bucket.
///
/// Returns the selector for a guided run, or an empty outcome for a direct
/// answer and for every degraded path. Degradation is silent by design: a
/// timeout, transport error, or invalid decision drops orient entirely and the
/// run proceeds on exactly today's path. Orient can add behavior; it can never
/// fail a run.
///
/// The status sentence is the optional part of the decision: a decision that
/// arrives without one still guides the run, it just does so silently.
pub(crate) async fn orient_once(
    session: &Arc<Session>,
    sink: &EventSink,
    request_text: &str,
) -> OrientOutcome {
    if request_text.trim().is_empty() || session.is_aborted() {
        return OrientOutcome::default();
    }
    let previous_response = latest_assistant_answer(session).await;
    let decision = match orient_request(session, request_text, &previous_response).await {
        Ok(decision) => decision,
        Err(error) => {
            sink.emit(json!({
                "type": "orient.decision",
                "taskId": session.task_id,
                "outcome": "degraded",
                "message": error,
                "at": now_iso()
            }));
            return OrientOutcome::default();
        }
    };
    let guided = decision.bucket != DIRECT_ANSWER_BUCKET;
    sink.emit(json!({
        "type": "orient.decision",
        "taskId": session.task_id,
        "outcome": if guided { "guided" } else { "direct" },
        "bucket": decision.bucket,
        // Distinguishes "the run opened with a status" from "the sentence was
        // dropped as invalid", which are indistinguishable in the transcript.
        "sentence": if decision.summary_sentence.is_some() { "emitted" } else { "missing" },
        // A guided run that may not answer without tool results is worth
        // seeing in the log: it is the precondition for the evidence retry.
        "evidenceRequired": decision.evidence_required,
        "at": now_iso()
    }));
    if !guided {
        return OrientOutcome::default();
    }
    if let Some(sentence) = decision.summary_sentence
        && !session.is_aborted()
    {
        // An ordinary assistant delta, deliberately: this sentence is the run's
        // one orientation, so it reads as the opening of the answer rather than
        // as machinery. The desktop settles pre-tool prose into its own message
        // and opens the working block beneath it, which is where an orientation
        // belongs — a sentence rendered *inside* that block described the same
        // work as the model's own preamble at a different altitude, so the two
        // landed on opposite sides of it. The trailing newlines keep it from
        // gluing to the model's first token. This is UI output only and is
        // never appended as an assistant conversation message.
        sink.emit(json!({
            "type": "assistant.delta",
            "taskId": session.task_id,
            "text": format!("{sentence}\n\n"),
            "at": now_iso()
        }));
    }
    OrientOutcome {
        bucket: Some(decision.bucket),
        evidence_required: decision.evidence_required,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The context that makes "yes, go ahead" classifiable is the last thing the
    // user actually read. Preambles are stored as tool-call messages with null
    // content, so the scan has to walk past them to the real answer — picking up
    // "Now I'll read the config" instead would describe work, not an offer.
    #[tokio::test]
    async fn context_is_the_last_finished_answer_not_a_preamble() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        *session.messages.lock().await = vec![
            json!({"role":"user","content":"add retries"}),
            json!({"role":"assistant","content":"I can add the retry wrapper. Want me to?"}),
            json!({"role":"user","content":"yes, go ahead"}),
            json!({"role":"assistant","content":null,"tool_calls":[
                {"id":"read-1","type":"function","function":{"name":"read","arguments":"{}"}}
            ]}),
            json!({"role":"tool","tool_call_id":"read-1","content":"file body"}),
        ];
        assert_eq!(
            latest_assistant_answer(&session).await,
            "I can add the retry wrapper. Want me to?"
        );
    }

    // An opening turn has nothing to carry, and must not invent any.
    #[tokio::test]
    async fn the_first_turn_carries_no_context() {
        let directory = tempfile::tempdir().unwrap();
        let session = crate::session::test_session(directory.path());
        *session.messages.lock().await = vec![json!({"role":"user","content":"hello"})];
        assert_eq!(latest_assistant_answer(&session).await, "");
    }
}
