use super::*;
use serde_json::json;

use crate::tools::ToolCall;

#[test]
fn the_backoff_covers_a_restart_without_stalling_on_a_recovered_server() {
    // Doubling at first, so a blip costs half a second rather than fifteen.
    assert_eq!(reconnect_delay_ms(1), 500);
    assert_eq!(reconnect_delay_ms(2), 1_000);
    assert_eq!(reconnect_delay_ms(4), 4_000);
    // Then a ceiling, which is what bounds how long a server that has already
    // come back waits to be noticed.
    for attempt in 6..=MAX_CONNECT_ATTEMPTS {
        assert_eq!(reconnect_delay_ms(attempt), RECONNECT_MAX_DELAY_MS);
    }
    // The budget is reached by many moderate waits rather than a few long
    // ones, which is the whole reason the ceiling is separate from the total.
    let at_ceiling = (1..MAX_CONNECT_ATTEMPTS)
        .filter(|attempt| reconnect_delay_ms(*attempt) == RECONNECT_MAX_DELAY_MS)
        .count();
    assert!(
        at_ceiling >= 15,
        "only {at_ceiling} waits sit at the ceiling, so the ladder is a handful \
         of long sleeps rather than a steady poll",
    );

    // The whole ladder covers a restart or a model reload — around five
    // minutes — and then stops. Holding a turn open longer than that is not
    // patience, it is a hang.
    let budget = reconnect_budget_ms();
    assert!(
        (4 * 60_000..=5 * 60_000).contains(&budget),
        "the retry ladder spans {budget}ms",
    );
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
