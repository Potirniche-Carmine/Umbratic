//! Hidden intent-bucket classification for one accepted run.
//!
//! Orient is a preflight, not a generation: it runs once per accepted run,
//! before the tool loop, and every step of that run reuses its decision. The
//! bucket id never leaves the runner-to-Veil path — it travels as a protected
//! selector on chat requests and is never placed in a runner event.

use std::sync::Arc;

use serde_json::json;

use crate::{
    events::now_iso,
    session::{EventSink, Session},
    veil_client::orient_request,
};

/// Classifies the accepted run into a hidden intent bucket.
///
/// Returns the selector for a guided run, or `None` for a direct answer and for
/// every degraded path. Degradation is silent by design: a timeout, transport
/// error, or invalid decision drops orient entirely and the run proceeds on
/// exactly today's path. Orient can add behavior; it can never fail a run.
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
        Err(_) => {
            // Clear the hint so the next run cannot reuse a stale bucket.
            *session
                .previous_bucket
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            return None;
        }
    };
    *session
        .previous_bucket
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(decision.bucket.clone());
    let sentence = decision.summary_sentence?;
    if session.is_aborted() {
        return Some(decision.bucket);
    }
    // The renderer concatenates consecutive deltas with no separator, so an
    // unterminated sentence would glue to the model's first token. This is UI
    // output only and is never appended as an assistant conversation message.
    sink.emit(json!({
        "type": "assistant.delta",
        "taskId": session.task_id,
        "text": format!("{sentence}\n\n"),
        "at": now_iso()
    }));
    Some(decision.bucket)
}
