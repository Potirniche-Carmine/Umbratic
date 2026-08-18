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

/// Retries made before anyone is told. A blip — a socket reset, a server that
/// is a second into a restart — is over before a notice could be read, and a
/// counter that appears at "3/10" the instant the request fails reads as
/// three failures the user was not warned about.
pub(crate) const QUIET_RETRIES: u32 = 2;
/// Retries the composer shows, each a full wait apart. Ten at half a minute
/// covers a server that is restarting or reloading a model, and then gives up:
/// holding a turn open longer than that is not patience, it is a hang. Stop
/// stays live throughout, so the wait costs the user nothing they cannot
/// interrupt.
pub(crate) const VISIBLE_RETRIES: u32 = 10;
pub(crate) const MAX_RETRIES: u32 = QUIET_RETRIES + VISIBLE_RETRIES;

const QUIET_DELAYS_MS: [u64; QUIET_RETRIES as usize] = [1_000, 2_000];
/// A quiet retry is quiet because it is quick. A server that asks for longer
/// than this — a `Retry-After` on a 503 — is asking for a wait the user would
/// otherwise sit through with a frozen composer and no explanation.
pub(crate) const QUIET_MAX_DELAY_MS: u64 = 5_000;
/// The wait between visible retries. Long enough that the count means
/// something — each tick is a real half-minute the server has been down —
/// rather than a number that climbs while the user watches.
pub(crate) const VISIBLE_DELAY_MS: u64 = 30_000;
/// A little spread over the visible wait, so every chat that lost the same
/// server does not retry in lockstep and meet a server coming back all at
/// once. Small on purpose: the notice says half a minute, and it should be one.
const VISIBLE_JITTER_MS: u64 = 3_000;
/// The ceiling on a single wait, `Retry-After` included, so a wrong or hostile
/// header cannot park a turn for an hour.
pub(crate) const RECONNECT_MAX_DELAY_MS: u64 = 60_000;

/// A server that says when to come back is obeyed rather than guessed at.
///
/// `Retry-After` is the standard answer to a 429 or a 503, and ignoring it is
/// the classic way a well-behaved client becomes the reason a loaded server
/// stays loaded. Only the delta-seconds form is honoured; the HTTP-date form is
/// rare from an inference gateway and falling back to the backoff is safe.
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

/// How long to wait before retry number `retry` (1-based), given whether the
/// user has already been shown a notice and whether the server named a wait.
///
/// The ladder is two quick quiet steps and then a flat half-minute: the early
/// steps catch a blip cheaply, and once the wait is long enough to see it stays
/// the same length so the count on screen is honest. Once shown, always shown —
/// a notice that comes and goes between attempts is worse than one that stays.
pub(crate) fn reconnect_delay_ms(retry: u32, shown: bool, retry_after: Option<u64>) -> u64 {
    if let Some(after) = retry_after {
        return after.min(RECONNECT_MAX_DELAY_MS);
    }
    if !shown && (1..=QUIET_RETRIES).contains(&retry) {
        return QUIET_DELAYS_MS[(retry - 1) as usize];
    }
    VISIBLE_DELAY_MS + (VISIBLE_JITTER_MS as f64 * random_fraction()) as u64
}

/// Whether this retry happens without telling the user: an early one, before
/// any notice, and short enough to be over before a notice would help.
pub(crate) fn retry_is_quiet(retry: u32, shown: bool, delay_ms: u64) -> bool {
    !shown && retry <= QUIET_RETRIES && delay_ms <= QUIET_MAX_DELAY_MS
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

/// Whether a failed Veil response is worth repeating.
///
/// Veil answers 502 for anything its runtime refused and says which status the
/// runtime gave. That upstream status is the one that matters: a runtime that
/// rejected the request outright — a chat template that raised on the prompt,
/// a malformed field — will reject it the same way ten more times, and calling
/// that "lost connection" for five minutes is a lie about what went wrong.
/// Only when there is no upstream status, because Veil never reached the
/// runtime, is Veil's own status the thing to judge.
pub(crate) fn retryable_veil_failure(status: u16, payload: Option<&Value>) -> bool {
    let upstream = payload
        .and_then(|value| value.get("upstreamStatus"))
        .and_then(Value::as_u64)
        .filter(|value| *value <= u16::MAX as u64)
        .map(|value| value as u16);
    retryable_status(upstream.unwrap_or(status))
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
/// already elapsed. `attempt` counts only the visible retries: the quiet ones
/// were never announced, so they are not part of the tally the user sees.
pub(crate) fn emit_reconnecting(
    session: &Session,
    sink: &EventSink,
    attempt: u32,
    max_attempts: u32,
    delay_ms: u64,
) {
    sink.emit(json!({
        "type": "provider.reconnecting",
        "taskId": session.task_id,
        "attempt": attempt,
        "maxAttempts": max_attempts,
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
