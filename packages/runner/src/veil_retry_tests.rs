use super::*;
use serde_json::json;

use crate::tools::ToolCall;

#[test]
fn the_first_retries_are_quick_and_quiet_and_the_rest_are_a_visible_half_minute() {
    // Two fast steps before anything is shown: a blip is over before a notice
    // could be read.
    assert_eq!(reconnect_delay_ms(1, false, None), 1_000);
    assert_eq!(reconnect_delay_ms(2, false, None), 2_000);
    for retry in 1..=QUIET_RETRIES {
        let delay = reconnect_delay_ms(retry, false, None);
        assert!(
            retry_is_quiet(retry, false, delay),
            "retry {retry} should be quiet"
        );
    }
    // Then a flat half-minute, jittered upward only a little, so the notice's
    // "half a minute" is one. Every one of those is shown.
    for retry in QUIET_RETRIES + 1..=MAX_RETRIES {
        let delay = reconnect_delay_ms(retry, true, None);
        assert!(
            (VISIBLE_DELAY_MS..VISIBLE_DELAY_MS + 3_500).contains(&delay),
            "retry {retry} waited {delay}ms"
        );
        assert!(
            !retry_is_quiet(retry, true, delay),
            "retry {retry} must be shown"
        );
    }
    // Once shown, always shown: an early retry number after a notice is no
    // longer quiet and no longer quick.
    assert!(!retry_is_quiet(1, true, 1_000));
    assert!(reconnect_delay_ms(1, true, None) >= VISIBLE_DELAY_MS);
    // A quiet retry is quiet because it is quick: a server asking for a long
    // wait on the first retry is asking for one the user should be told about.
    assert!(!retry_is_quiet(1, false, QUIET_MAX_DELAY_MS + 1));

    // Two visible waits at the same retry must not be identical, or the jitter
    // is not doing the one job it exists for.
    let draws = (0..24)
        .map(|_| reconnect_delay_ms(5, true, None))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(draws.len() > 1, "the visible wait is not actually jittered");

    // Ten visible half-minutes covers a restart or a model reload, and then it
    // stops. Holding a turn open longer than that is not patience, it is a hang.
    let budget =
        QUIET_RETRIES as u64 * QUIET_MAX_DELAY_MS + VISIBLE_RETRIES as u64 * VISIBLE_DELAY_MS;
    assert!(
        (3 * 60_000..=6 * 60_000).contains(&budget),
        "the retry ladder spans {budget}ms",
    );
}

#[test]
fn a_server_that_says_when_to_come_back_is_obeyed_within_reason() {
    assert_eq!(retry_after_ms(Some("2")), Some(2_000));
    assert_eq!(retry_after_ms(Some("  30 ")), Some(30_000));
    // A header takes precedence over the computed backoff.
    assert_eq!(reconnect_delay_ms(1, false, Some(9_000)), 9_000);
    assert_eq!(reconnect_delay_ms(7, true, Some(9_000)), 9_000);
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
fn a_runtime_that_rejected_the_request_is_not_a_lost_connection() {
    // Veil answers 502 for anything its runtime refused. The runtime's own
    // status decides: a template that raised on the prompt raises again.
    let rejected = json!({"code": "model_service_rejected", "upstreamStatus": 500});
    assert!(!retryable_veil_failure(502, Some(&rejected)));
    let malformed = json!({"code": "model_service_rejected", "upstreamStatus": 400});
    assert!(!retryable_veil_failure(502, Some(&malformed)));
    // A runtime that is loading, busy, or gone answers differently in a while.
    for upstream in [503, 429, 502, 504] {
        let payload = json!({"code": "model_service_rejected", "upstreamStatus": upstream});
        assert!(
            retryable_veil_failure(502, Some(&payload)),
            "upstream {upstream}"
        );
    }
    // No upstream status means Veil never reached the runtime, and Veil's own
    // status is the one to judge.
    let unreachable = json!({"code": "model_service_unavailable"});
    assert!(retryable_veil_failure(502, Some(&unreachable)));
    assert!(retryable_veil_failure(503, None));
    assert!(!retryable_veil_failure(401, None));
    // A nonsense upstream status falls back to Veil's own.
    let nonsense = json!({"upstreamStatus": 99_999});
    assert!(retryable_veil_failure(502, Some(&nonsense)));
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
