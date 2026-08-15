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
/// Ten, which with the ceiling below covers a server that is restarting or
/// reloading a model — a few minutes — and then gives up. Stop stays live
/// throughout, so the wait costs the user nothing they cannot interrupt.
pub(crate) const MAX_CONNECT_ATTEMPTS: u32 = 10;
pub(crate) const RECONNECT_BASE_DELAY_MS: u64 = 500;
/// The ceiling on a single wait. Ten attempts covering minutes forces a large
/// one: the two numbers trade directly against each other, and this is the
/// side of that trade the attempt count leaves.
pub(crate) const RECONNECT_MAX_DELAY_MS: u64 = 60_000;

/// The unjittered ceiling for one attempt: plain capped exponential growth.
pub(crate) fn reconnect_window_ms(attempt: u32) -> u64 {
    RECONNECT_BASE_DELAY_MS
        .saturating_mul(1_u64 << attempt.saturating_sub(1).min(16))
        .min(RECONNECT_MAX_DELAY_MS)
}

/// Equal jitter over that window: half the window, plus a uniform draw over the
/// other half.
///
/// Jitter is the part of exponential backoff that is easiest to leave out and
/// most worth keeping. Without it every chat that lost the same server retries
/// in lockstep, so a server coming back is met by all of them at once and may
/// go straight back down — and they stay synchronized on the next round.
/// Halving rather than drawing over the whole window (full jitter) keeps a
/// floor under the delay, so a long outage cannot degenerate into a fast poll.
pub(crate) fn jittered_delay_ms(window_ms: u64, fraction: f64) -> u64 {
    let half = window_ms / 2;
    half + (half as f64 * fraction.clamp(0.0, 1.0)) as u64
}

/// A server that says when to come back is obeyed rather than guessed at.
///
/// `Retry-After` is the standard answer to a 429 or a 503, and ignoring it is
/// the classic way a well-behaved client becomes the reason a loaded server
/// stays loaded. Only the delta-seconds form is honoured; the HTTP-date form is
/// rare from an inference gateway and falling back to the backoff is safe.
/// Bounded by the same ceiling as everything else, so a wrong or hostile header
/// cannot park a turn for an hour.
pub(crate) fn retry_after_ms(header: Option<&str>) -> Option<u64> {
    header?
        .trim()
        .parse::<u64>()
        .ok()?
        .saturating_mul(1_000)
        .min(RECONNECT_MAX_DELAY_MS)
        .into()
}

/// Reads the header off a response, before its body is consumed.
pub(crate) fn retry_after_from(response: &reqwest::Response) -> Option<u64> {
    retry_after_ms(
        response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok()),
    )
}

/// How long to wait before the next attempt.
pub(crate) fn reconnect_delay_ms(attempt: u32, retry_after: Option<u64>) -> u64 {
    retry_after
        .unwrap_or_else(|| jittered_delay_ms(reconnect_window_ms(attempt), random_fraction()))
}

/// A uniform draw in [0, 1).
///
/// From `uuid`'s random bytes rather than a new dependency: this needs to
/// decorrelate retries, not to be sound for anything that cares about the
/// quality of its randomness.
fn random_fraction() -> f64 {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64 / (u32::MAX as f64 + 1.0)
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
    /// The server's own instruction for when to come back, when it gave one.
    pub(crate) retry_after_ms: Option<u64>,
}

impl VeilAttemptError {
    pub(crate) fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
            committed: false,
            retry_after_ms: None,
        }
    }

    pub(crate) fn final_failure(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            committed: false,
            retry_after_ms: None,
        }
    }

    pub(crate) fn committed_if(mut self, committed: bool) -> Self {
        self.committed = committed;
        self
    }

    pub(crate) fn after(mut self, retry_after_ms: Option<u64>) -> Self {
        self.retry_after_ms = retry_after_ms;
        self
    }
}

#[cfg(test)]
#[path = "veil_retry_tests.rs"]
mod tests;
