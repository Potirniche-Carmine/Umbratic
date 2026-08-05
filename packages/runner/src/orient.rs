//! Hidden intent-bucket classification for one accepted run.
//!
//! Orient is a preflight, not a generation: it runs once per accepted run,
//! before the tool loop, and every step of that run reuses its decision. The
//! decision is broadcast as an `orient.decision` event so harness logs (runner
//! diagnostics and the desktop's local event log) can answer "which bucket
//! fired?"; the desktop records it as a diagnostic only and never renders it,
//! so the bucket id still never appears in chat output.

use std::sync::Arc;

use serde_json::json;

use crate::{
    events::now_iso,
    session::{EventSink, Session},
    veil_client::{DIRECT_ANSWER_BUCKET, orient_request},
};

/// Classifies the accepted run into a hidden intent bucket.
///
/// Returns the selector for a guided run, or `None` for a direct answer and for
/// every degraded path. Degradation is silent by design: a timeout, transport
/// error, or invalid decision drops orient entirely and the run proceeds on
/// exactly today's path. Orient can add behavior; it can never fail a run.
///
/// The status sentence is the optional part of the decision: a decision that
/// arrives without one still guides the run, it just does so silently.
pub(crate) async fn orient_once(
    session: &Arc<Session>,
    sink: &EventSink,
    request_text: &str,
) -> Option<String> {
    if request_text.trim().is_empty() || session.is_aborted() {
        return None;
    }
    let previous = session
        .previous_bucket
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let decision = match orient_request(session, request_text, previous.as_deref()).await {
        Ok(decision) => decision,
        Err(error) => {
            // Clear the hint so the next run cannot reuse a stale bucket.
            *session
                .previous_bucket
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            sink.emit(json!({
                "type": "orient.decision",
                "taskId": session.task_id,
                "outcome": "degraded",
                "message": error,
                "at": now_iso()
            }));
            return None;
        }
    };
    *session
        .previous_bucket
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(decision.bucket.clone());
    let guided = decision.bucket != DIRECT_ANSWER_BUCKET;
    sink.emit(json!({
        "type": "orient.decision",
        "taskId": session.task_id,
        "outcome": if guided { "guided" } else { "direct" },
        "bucket": decision.bucket,
        // Distinguishes "the run opened with a status" from "the sentence was
        // dropped as invalid", which are indistinguishable in the transcript.
        "sentence": if decision.summary_sentence.is_some() { "emitted" } else { "missing" },
        "at": now_iso()
    }));
    if !guided {
        return None;
    }
    if let Some(sentence) = decision.summary_sentence
        && !session.is_aborted()
    {
        // The renderer concatenates consecutive deltas with no separator, so an
        // unterminated sentence would glue to the model's first token. This is
        // UI output only and is never appended as an assistant conversation
        // message.
        sink.emit(json!({
            "type": "assistant.delta",
            "taskId": session.task_id,
            "text": format!("{sentence}\n\n"),
            "at": now_iso()
        }));
    }
    Some(decision.bucket)
}
