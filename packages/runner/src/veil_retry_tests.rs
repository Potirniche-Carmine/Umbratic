use super::*;
use serde_json::json;

use crate::tools::ToolCall;

#[test]
fn the_backoff_grows_but_is_capped_so_a_recovered_server_is_noticed() {
    // Doubling, then a ceiling: a server that comes back should be used again
    // within seconds of doing so, not after a minute of unbounded backoff.
    assert_eq!(reconnect_delay_ms(1), 500);
    assert_eq!(reconnect_delay_ms(2), 1_000);
    assert_eq!(reconnect_delay_ms(4), 4_000);
    for attempt in 5..=MAX_CONNECT_ATTEMPTS {
        assert_eq!(reconnect_delay_ms(attempt), RECONNECT_MAX_DELAY_MS);
    }
    // The whole ladder is a wait a person will sit through, not an afternoon.
    let total: u64 = (1..MAX_CONNECT_ATTEMPTS).map(reconnect_delay_ms).sum();
    assert!(total < 60_000, "the retry ladder spans {total}ms");
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

    // Text withheld by a guided step still exists and would be duplicated.
    let held = VeilChatResult {
        held_text: "partial answer".into(),
        ..VeilChatResult::default()
    };
    assert!(committed_output(&held, &partial, false));
}
