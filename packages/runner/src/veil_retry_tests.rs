use super::*;
use serde_json::json;

use crate::tools::ToolCall;

#[test]
fn the_backoff_is_capped_exponential_growth() {
    assert_eq!(reconnect_window_ms(1), 500);
    assert_eq!(reconnect_window_ms(2), 1_000);
    assert_eq!(reconnect_window_ms(4), 4_000);
    assert_eq!(reconnect_window_ms(7), 32_000);
    for attempt in 8..=MAX_CONNECT_ATTEMPTS {
        assert_eq!(reconnect_window_ms(attempt), RECONNECT_MAX_DELAY_MS);
    }
    // Ten attempts covering a restart, and then it stops. Holding a turn open
    // longer than that is not patience, it is a hang.
    let budget: u64 = (1..MAX_CONNECT_ATTEMPTS).map(reconnect_window_ms).sum();
    assert!(
        (60_000..=5 * 60_000).contains(&budget),
        "the retry ladder spans {budget}ms",
    );
}

#[test]
fn every_wait_is_jittered_within_the_upper_half_of_its_window() {
    // Equal jitter: never below half the window, so a long outage cannot
    // degenerate into a fast poll; never above it, so the ladder stays bounded.
    for window in [500_u64, 4_000, 60_000] {
        assert_eq!(jittered_delay_ms(window, 0.0), window / 2);
        assert_eq!(jittered_delay_ms(window, 1.0), window);
        for fraction in [0.01, 0.25, 0.5, 0.99] {
            let delay = jittered_delay_ms(window, fraction);
            assert!(
                (window / 2..=window).contains(&delay),
                "{window} {fraction}"
            );
        }
    }
    // A nonsense fraction cannot escape the window either.
    assert_eq!(jittered_delay_ms(1_000, -5.0), 500);
    assert_eq!(jittered_delay_ms(1_000, 5.0), 1_000);

    // Two consecutive waits at the same attempt must not be identical, or the
    // jitter is not doing the one job it exists for.
    let draws = (0..24)
        .map(|_| reconnect_delay_ms(8, None))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(draws.len() > 1, "the backoff is not actually jittered");
}

#[test]
fn a_server_that_says_when_to_come_back_is_obeyed_within_reason() {
    assert_eq!(retry_after_ms(Some("2")), Some(2_000));
    assert_eq!(retry_after_ms(Some("  30 ")), Some(30_000));
    // A header takes precedence over the computed backoff.
    assert_eq!(reconnect_delay_ms(1, Some(9_000)), 9_000);
    // A wrong or hostile value cannot park a turn for an hour.
    assert_eq!(retry_after_ms(Some("86400")), Some(RECONNECT_MAX_DELAY_MS));
    // The HTTP-date form and anything unparseable fall back to the backoff.
    assert_eq!(retry_after_ms(Some("Wed, 21 Oct 2026 07:28:00 GMT")), None);
    assert_eq!(retry_after_ms(Some("")), None);
    assert_eq!(retry_after_ms(None), None);
}

#[test]
fn only_statuses_that_could_answer_differently_are_repeated() {
    for status in [408, 429, 502, 503, 504] {
        assert!(retryable_status(status), "{status} should be retried");
    }
    // A considered answer is not a transport failure: repeating a rejected key
    // or a malformed request just fails ten times instead of once.
    for status in [400, 401, 403, 404, 409, 422, 500, 501] {
        assert!(!retryable_status(status), "{status} must not be retried");
    }
}

#[test]
fn a_turn_that_produced_anything_is_committed_and_never_retried() {
    let partial = BTreeMap::new();
    assert!(!committed_output(
        &VeilChatResult::default(),
        &partial,
        false
    ));

    // Text already on the user's screen.
    assert!(committed_output(&VeilChatResult::default(), &partial, true));

    // A tool call on its way to an executor.
    let mut with_call = VeilChatResult::default();
    with_call.tool_calls.push(ToolCall {
        id: "call-1".into(),
        name: "read".into(),
        arguments: json!({}),
        index: 0,
    });
    assert!(committed_output(&with_call, &partial, false));

    // A half-assembled tool call is just as committing: re-sending would run
    // the completed half twice.
    let mut assembling = BTreeMap::new();
    assembling.insert(0, ("call-1".into(), "read".into(), "{\"pa".into()));
    assert!(committed_output(
        &VeilChatResult::default(),
        &assembling,
        false
    ));

    // Text already on the result is committed: re-sending would duplicate it.
    assert!(committed_output(
        &VeilChatResult {
            content: "partial answer".into(),
            ..VeilChatResult::default()
        },
        &partial,
        false
    ));
}
