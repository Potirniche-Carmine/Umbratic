//! When a request to Veil may be sent again, and how long to wait first.
//!
//! Veil already retries its own call to the runtime once, and only before the
//! response is semantically committed. This is the same rule one layer up, for
//! the hop the runner owns: the desktop's connection to Veil itself, which is
//! the one a person notices when the server restarts under them.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::{
    events::now_iso,
    session::{EventSink, Session},
    veil_client::VeilChatResult,
};

/// How many times a request that has committed nothing may be re-sent.
///
/// The window this covers is a server that is restarting or briefly
/// unreachable, not one that is down for the afternoon: ten attempts on the
/// backoff below spans under a minute, after which the honest answer is to fail
/// the turn rather than keep a person watching a spinner.
pub(crate) const MAX_CONNECT_ATTEMPTS: u32 = 10;
pub(crate) const RECONNECT_BASE_DELAY_MS: u64 = 500;
pub(crate) const RECONNECT_MAX_DELAY_MS: u64 = 8_000;

/// Exponential backoff, capped. The cap matters more than the growth: a server
/// that comes back should be used again within seconds of doing so, and
/// doubling without a ceiling would leave a recovered server idle for a minute.
pub(crate) fn reconnect_delay_ms(attempt: u32) -> u64 {
    RECONNECT_BASE_DELAY_MS
        .saturating_mul(1_u64 << attempt.saturating_sub(1).min(6))
        .min(RECONNECT_MAX_DELAY_MS)
}

/// Statuses worth repeating. A gateway with no upstream right now, a loaded
/// runtime, or a timeout may all answer differently in a second; every other
/// status is the server's considered answer, and asking ten more times would
/// only fail ten more times.
pub(crate) fn retryable_status(status: u16) -> bool {
    matches!(status, 408 | 429 | 502 | 503 | 504)
}

/// Whether this turn has produced anything the caller could already have acted
/// on. Streamed text is on the user's screen and a tool call is on its way to
/// an executor; re-sending the request after either would duplicate work rather
/// than recover it.
pub(crate) fn committed_output(
    result: &VeilChatResult,
    partial: &BTreeMap<usize, (String, String, String)>,
    text_streamed: bool,
) -> bool {
    text_streamed
        || !result.tool_calls.is_empty()
        || !partial.is_empty()
        || !result.held_text.is_empty()
        || !result.content.is_empty()
}

/// Waits out a backoff without making Stop wait for it. Returns false if the
/// user aborted during the delay.
pub(crate) async fn sleep_unless_aborted(session: &Session, millis: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(millis);
    while std::time::Instant::now() < deadline {
        if session.is_aborted() {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    !session.is_aborted()
}

/// The immutable inputs to one attempt, captured once so that a retry re-sends
/// exactly what the first attempt sent.
pub(crate) struct VeilAttemptInput {
    pub(crate) endpoint: url::Url,
    pub(crate) host_header: Option<String>,
    pub(crate) body: Value,
    pub(crate) hold_assistant_text: bool,
}

/// Announces that the turn is waiting on a server it cannot reach.
///
/// Emitted before the wait rather than after it, so the composer can show the
/// attempt the user is currently sitting through instead of the one that has
/// already elapsed.
pub(crate) fn emit_reconnecting(session: &Session, sink: &EventSink, attempt: u32, delay_ms: u64) {
    sink.emit(json!({
        "type": "provider.reconnecting",
        "taskId": session.task_id,
        "attempt": attempt,
        "maxAttempts": MAX_CONNECT_ATTEMPTS,
        "delayMs": delay_ms,
        "at": now_iso()
    }));
}

/// Announces that a retried request got through, so the notice can clear.
pub(crate) fn emit_reconnected(session: &Session, sink: &EventSink, attempt: u32) {
    sink.emit(json!({
        "type": "provider.reconnected",
        "taskId": session.task_id,
        "attempt": attempt,
        "at": now_iso()
    }));
}

/// One attempt's failure, carrying the two facts the retry loop needs.
pub(crate) struct VeilAttemptError {
    pub(crate) message: String,
    pub(crate) retryable: bool,
    pub(crate) committed: bool,
}

impl VeilAttemptError {
    pub(crate) fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
            committed: false,
        }
    }

    pub(crate) fn final_failure(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            committed: false,
        }
    }

    pub(crate) fn committed_if(mut self, committed: bool) -> Self {
        self.committed = committed;
        self
    }
}

#[cfg(test)]
#[path = "veil_retry_tests.rs"]
mod tests;
