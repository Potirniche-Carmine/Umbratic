use super::*;
use std::sync::Arc;

use crate::{
    context::{ContextBreakdown, SessionContextStore},
    context_events::SessionEstimateState,
    session::{test_config, test_session},
};

#[test]
fn tool_execution_segments_use_path_scoped_conflicts_and_global_barriers() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("a.txt"), "a").unwrap();
    std::fs::write(directory.path().join("b.txt"), "b").unwrap();
    let session = crate::session::test_session(directory.path());
    let call = |id: &str, name: &str, file_path: Option<&str>| ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: file_path
            .map(|path| json!({"path":path}))
            .unwrap_or_else(|| json!({"command":"echo test"})),
        index: 0,
    };

    let independent = vec![
        call("write-a", "write", Some("a.txt")),
        call("edit-b", "edit", Some("b.txt")),
    ];
    assert_eq!(
        crate::tool_scheduling::execution_segments(&session, &independent),
        vec![vec![0, 1]]
    );

    let conflict = vec![
        call("write-a", "write", Some("a.txt")),
        call("read-a", "read", Some("a.txt")),
    ];
    assert_eq!(
        crate::tool_scheduling::execution_segments(&session, &conflict),
        vec![vec![0], vec![1]]
    );

    let command = vec![
        call("read-a", "read", Some("a.txt")),
        call("command", "command", None),
        call("read-b", "read", Some("b.txt")),
    ];
    assert_eq!(
        crate::tool_scheduling::execution_segments(&session, &command),
        vec![vec![0], vec![1], vec![2]]
    );
}

#[tokio::test]
async fn tool_history_stays_append_only_without_context_pressure() {
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let mut messages = vec![json!({"role":"user","content":"original request"})];
    for index in 0..14 {
        messages.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":format!("call-{index}"),"type":"function","function":{"name":"read","arguments":"{}"}}]}));
        messages.push(json!({"role":"tool","tool_call_id":format!("call-{index}"),"content":format!("read result {index}")}));
    }
    *session.messages.lock().await = messages.clone();
    let tools = crate::tools::tool_surface(&session).specs().to_vec();
    let prepared = prepared_messages(&session, &tools).await.unwrap();
    assert_eq!(prepared.messages, messages);
}

#[test]
fn pressure_compaction_removes_one_complete_parallel_exchange() {
    let mut messages = vec![json!({"role":"user","content":"original request"})];
    for index in 0..14 {
        messages.push(json!({"role":"assistant","content":null,"tool_calls":[
            {"id":format!("call-{index}-a"),"type":"function","function":{"name":"read","arguments":"{}"}},
            {"id":format!("call-{index}-b"),"type":"function","function":{"name":"search","arguments":"{}"}}
        ]}));
        messages.push(json!({"role":"tool","tool_call_id":format!("call-{index}-a"),"content":format!("read result {index}")}));
        messages.push(json!({"role":"tool","tool_call_id":format!("call-{index}-b"),"content":format!("search result {index}")}));
    }
    assert!(compact_oldest_tool_exchange(&mut messages));
    assert_eq!(structured_tool_exchanges(&messages).len(), 13);
    assert!(!messages.iter().any(|message| {
        matches!(
            message["tool_call_id"].as_str(),
            Some("call-0-a" | "call-0-b")
        )
    }));
    let summary = messages
        .iter()
        .find_map(|message| {
            message["content"]
                .as_str()
                .filter(|content| content.starts_with(TOOL_HISTORY_SUMMARY_PREFIX))
        })
        .unwrap();
    assert!(summary.contains("read result 0") && summary.contains("search result 0"));
}

#[test]
fn pressure_compaction_refuses_incomplete_parallel_batch() {
    let mut messages = vec![
        json!({"role":"user","content":"original request"}),
        json!({"role":"assistant","content":null,"tool_calls":[
            {"id":"a","type":"function","function":{"name":"read","arguments":"{}"}},
            {"id":"b","type":"function","function":{"name":"read","arguments":"{}"}}
        ]}),
        json!({"role":"tool","tool_call_id":"a","content":"only first result"}),
        json!({"role":"user","content":"later"}),
    ];
    assert!(!compact_oldest_tool_exchange(&mut messages));
    assert_eq!(messages[1]["tool_calls"].as_array().unwrap().len(), 2);
    assert_eq!(messages[2]["tool_call_id"], "a");
}

#[test]
fn first_tool_history_summary_is_bounded() {
    let mut messages = vec![json!({"role":"user","content":"original request"})];
    append_compacted_summary(&mut messages, 1, &"x".repeat(20_000));
    let summary = messages[1]["content"].as_str().unwrap();
    assert!(summary.len() <= MAX_TOOL_HISTORY_SUMMARY_CHARS);
    assert!(summary.starts_with(TOOL_HISTORY_SUMMARY_PREFIX));
    assert!(summary.contains(TOOL_HISTORY_ELISION));
}

#[tokio::test]
async fn observed_usage_does_not_double_count_protected_prompts_or_completion() {
    let directory = tempfile::tempdir().unwrap();
    let session = test_session(directory.path());
    let result = VeilChatResult {
        prompt_tokens: Some(12_000),
        completion_tokens: Some(800),
        system_prompt_tokens: Some(3_187),
        system_prompt_tokens_exact: true,
        ..VeilChatResult::default()
    };
    let breakdown = ContextBreakdown {
        conversation_tokens: 900,
        tool_result_tokens: 120,
        ..ContextBreakdown::default()
    };
    let usage = observed_context_event(&session, &result, 4_096, breakdown).unwrap();
    assert_eq!(usage["contentTokens"], 12_000);
    assert_eq!(usage["completionTokens"], 800);
    assert_eq!(usage["reserveTokens"], 4_096);
    assert_eq!(usage["estimatedTokens"], 16_096);
    assert_eq!(usage["phase"], "observed");
    assert_eq!(usage["anchored"], true);
    assert_eq!(usage["compactionBlocked"], false);
    // The response's own measurement of the protected prefix beats whatever
    // stand-in the request was assembled with.
    assert_eq!(usage["protectedTokens"], 3_187);
    assert_eq!(usage["breakdown"]["systemPromptTokens"], 3_187);
    assert_eq!(usage["breakdown"]["systemPromptExact"], true);
    // Estimated rows are reconciled to the measured total: the exact system
    // row is preserved, the rest is apportioned by the rows' proportions, and
    // the parts always sum to the headline the meter shows.
    let conversation = usage["breakdown"]["conversationTokens"].as_u64().unwrap();
    let tool_results = usage["breakdown"]["toolResultTokens"].as_u64().unwrap();
    assert_eq!(3_187 + conversation + tool_results, 12_000);
    assert!(
        conversation > tool_results * 7,
        "reconciliation lost the rows' proportions: {conversation} vs {tool_results}"
    );
    assert_eq!(
        usage["estimatedTokens"].as_u64().unwrap(),
        usage["contentTokens"].as_u64().unwrap() + usage["reserveTokens"].as_u64().unwrap()
    );
}

#[test]
fn semantic_split_preserves_latest_user_and_complete_active_tool_exchange() {
    let mut messages = (0..8)
        .flat_map(|index| {
            [
                json!({"role":"user","content":format!("old request {index} {}", "x".repeat(400))}),
                json!({"role":"assistant","content":format!("old answer {index}")}),
            ]
        })
        .collect::<Vec<_>>();
    let latest = messages.len();
    messages.push(json!({"role":"user","content":"latest real user request"}));
    messages.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":"a"},{"id":"b"}]}));
    messages.push(json!({"role":"tool","tool_call_id":"a","content":"first"}));
    messages.push(json!({"role":"tool","tool_call_id":"b","content":"second"}));
    let split = semantic_prefix_end(&messages, 64_000).unwrap();
    assert_eq!(split, latest);
    assert_eq!(messages[split]["content"], "latest real user request");
    assert!(
        messages[split..]
            .iter()
            .filter(|message| message["role"] == "tool")
            .all(|message| {
                message.get("tool_call_id").is_some()
                    && messages[split..]
                        .iter()
                        .any(|candidate| candidate.get("tool_calls").is_some())
            })
    );
}

#[test]
fn fitted_compaction_retry_stops_on_complete_group_boundaries() {
    let messages = vec![
        json!({"role":"user","content":"x".repeat(1000)}),
        json!({"role":"assistant","content":null,"tool_calls":[{"id":"a"},{"id":"b"}]}),
        json!({"role":"tool","tool_call_id":"a","content":"y".repeat(1000)}),
        json!({"role":"tool","tool_call_id":"b","content":"z".repeat(1000)}),
        json!({"role":"assistant","content":"done"}),
    ];
    let end = fitted_compaction_end(&messages, messages.len()).unwrap();
    assert!(end == 1 || end == 4);
    assert_ne!(messages[end - 1]["role"], "assistant");
    if messages[end - 1]["role"] == "tool" {
        assert_eq!(messages[end - 2]["role"], "tool");
        assert!(messages[end - 3].get("tool_calls").is_some());
    }
}

#[test]
fn semantic_compaction_retains_exact_failure_change_and_verification_anchors() {
    let messages = vec![
        json!({"role":"assistant","content":"Tests failed with exact exit code 29."}),
        json!({"role":"assistant","content":"Changed packages/runner/src/conversation_state.rs."}),
        json!({"role":"assistant","content":"cargo test --locked passed."}),
    ];
    let (_, carriers) = compaction_source(&messages);
    let encoded = serde_json::to_string(&carriers).unwrap();
    assert!(encoded.contains("exit code 29"));
    assert!(encoded.contains("packages/runner/src/conversation_state.rs"));
    assert!(encoded.contains("cargo test --locked passed"));
    assert!(!valid_semantic_summary("generic summary"));
    assert!(valid_semantic_summary(
        "Goal and current request\nConstraints and decisions\nWork completed\nFiles and verification\nErrors or blockers\nNext work"
    ));
}

#[tokio::test]
async fn preflight_compacts_complete_tool_lifecycles_until_the_request_fits() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = (*test_config(directory.path())).clone();
    config.context_length = 4_000;
    config.max_response_tokens = 4_096;
    config.protected_prompt_reserve_tokens = 0;
    let mut history = vec![json!({"role":"user","content":"original request"})];
    for index in 0..14 {
        history.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":format!("call-{index}"),"type":"function","function":{"name":"read","arguments":"{}"}}]}));
        history.push(json!({"role":"tool","tool_call_id":format!("call-{index}"),"content":format!("result {index}: {}", "x".repeat(4_000))}));
    }
    let session = Session {
        id: "session".into(),
        task_id: "task".into(),
        config: Arc::new(config),
        messages: tokio::sync::Mutex::new(history),
        durable_summary: tokio::sync::Mutex::new(None),
        failed_compaction_digest: tokio::sync::Mutex::new(None),
        compaction_count: std::sync::atomic::AtomicU32::new(0),
        compaction_strikes: std::sync::atomic::AtomicU32::new(0),
        awaiting_observed_usage: std::sync::atomic::AtomicBool::new(false),
        usage_anchor: tokio::sync::Mutex::new(None),
        system_prompt_size: tokio::sync::Mutex::new(None),
        context_calibration: tokio::sync::Mutex::new(None),
        context_store: tokio::sync::Mutex::new(SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: crate::skill_preflight::SharedSkillCache::default(),
        run: std::sync::Mutex::new(None),
        search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
        tool_surface: std::sync::OnceLock::new(),
        queue: tokio::sync::Mutex::new(crate::run_queue::RunQueue::default()),
    };

    let prepared = prepared_messages(&session, &[]).await.unwrap();
    let usage = context_event(&session, prepared.usage);
    assert!(usage["estimatedTokens"].as_u64().unwrap() <= 4_000);
    assert!(prepared.max_output_tokens >= 1_000);
    assert!(
        prepared
            .messages
            .iter()
            .any(|message| message["content"] == "original request")
    );
    for (index, message) in prepared.messages.iter().enumerate() {
        if message["role"] == "tool" {
            assert!(index > 0 && prepared.messages[index - 1].get("tool_calls").is_some());
        }
    }
}

#[tokio::test]
async fn preflight_rejects_an_oversized_atomic_user_request() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = (*test_config(directory.path())).clone();
    config.context_length = 4_000;
    config.max_response_tokens = 4_096;
    config.protected_prompt_reserve_tokens = 0;
    let session = Session {
        id: "session".into(),
        task_id: "task".into(),
        config: Arc::new(config),
        messages: tokio::sync::Mutex::new(vec![json!({
            "role":"user",
            "content":"x".repeat(20_000)
        })]),
        durable_summary: tokio::sync::Mutex::new(None),
        failed_compaction_digest: tokio::sync::Mutex::new(None),
        compaction_count: std::sync::atomic::AtomicU32::new(0),
        compaction_strikes: std::sync::atomic::AtomicU32::new(0),
        awaiting_observed_usage: std::sync::atomic::AtomicBool::new(false),
        usage_anchor: tokio::sync::Mutex::new(None),
        system_prompt_size: tokio::sync::Mutex::new(None),
        context_calibration: tokio::sync::Mutex::new(None),
        context_store: tokio::sync::Mutex::new(SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: crate::skill_preflight::SharedSkillCache::default(),
        run: std::sync::Mutex::new(None),
        search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
        tool_surface: std::sync::OnceLock::new(),
        queue: tokio::sync::Mutex::new(crate::run_queue::RunQueue::default()),
    };

    let error = prepared_messages(&session, &[]).await.unwrap_err();
    assert!(error.contains("Context window is full"));
    assert!(error.contains("4000"));
}

#[test]
fn a_compaction_cut_never_splits_a_tool_batch() {
    // Invariant 3: nothing may be inserted between an assistant tool-call
    // message and all results for that batch, so a cut cannot land inside one.
    let messages = vec![
        json!({"role":"user","content":"first request"}),
        json!({"role":"assistant","content":null,"tool_calls":[
            {"id":"call-a","type":"function","function":{"name":"read","arguments":"{}"}},
            {"id":"call-b","type":"function","function":{"name":"read","arguments":"{}"}}
        ]}),
        json!({"role":"tool","tool_call_id":"call-a","content":"read: a (ok)"}),
        json!({"role":"tool","tool_call_id":"call-b","content":"read: b (ok)"}),
        json!({"role":"assistant","content":"done"}),
        json!({"role":"user","content":"second request"}),
    ];
    // Every proposed cut resolves to a boundary that leaves no orphan results.
    for proposed in 0..=messages.len() {
        let Some(cut) = safe_cut_point(&messages, proposed) else {
            continue;
        };
        assert!(
            missing_tool_results(&messages[..cut]).is_empty(),
            "cut at {cut} (proposed {proposed}) orphaned a tool call",
        );
        assert_ne!(
            messages
                .get(cut)
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str),
            Some("tool"),
            "cut at {cut} landed on a tool result",
        );
    }
    // The cut inside the batch is walked back to before the assistant message.
    assert_eq!(safe_cut_point(&messages, 3), Some(1));
}

#[tokio::test]
async fn compaction_refuses_while_a_tool_batch_is_unresolved() {
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let mut messages = vec![
        json!({"role":"user","content":"x".repeat(4_000)}),
        json!({"role":"assistant","content":null,"tool_calls":[
            {"id":"pending","type":"function","function":{"name":"read","arguments":"{}"}}
        ]}),
    ];
    assert!(
        !attempt_semantic_compaction(
            &session,
            &mut messages,
            &[],
            &SessionEstimateState::default()
        )
        .await,
        "compaction must not run inside an active step",
    );
}

#[test]
fn a_persisted_tool_step_never_carries_the_preamble_back_into_context() {
    let calls = vec![ToolCall {
        id: "call-1".into(),
        name: "ls".into(),
        arguments: json!({"path":"."}),
        index: 0,
    }];
    let message = assistant_tool_message(&calls);

    // The preamble streamed to the desktop already. Persisting it would give the
    // next step of this turn a longer preamble to imitate, which is the whole
    // mid-turn-recap ratchet.
    assert_eq!(message["content"], Value::Null);
    assert_eq!(message["tool_calls"][0]["id"], "call-1");
    assert_eq!(message["tool_calls"][0]["function"]["name"], "ls");
}

fn session_with(config: crate::config::RunnerConfig, messages: Vec<Value>) -> Session {
    Session {
        id: "session".into(),
        task_id: "task".into(),
        config: Arc::new(config),
        messages: tokio::sync::Mutex::new(messages),
        durable_summary: tokio::sync::Mutex::new(None),
        failed_compaction_digest: tokio::sync::Mutex::new(None),
        compaction_count: std::sync::atomic::AtomicU32::new(0),
        compaction_strikes: std::sync::atomic::AtomicU32::new(0),
        awaiting_observed_usage: std::sync::atomic::AtomicBool::new(false),
        usage_anchor: tokio::sync::Mutex::new(None),
        system_prompt_size: tokio::sync::Mutex::new(None),
        context_calibration: tokio::sync::Mutex::new(None),
        context_store: tokio::sync::Mutex::new(SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: crate::skill_preflight::SharedSkillCache::default(),
        run: std::sync::Mutex::new(None),
        search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
        tool_surface: std::sync::OnceLock::new(),
        queue: tokio::sync::Mutex::new(crate::run_queue::RunQueue::default()),
    }
}

fn measured(prompt_tokens: u64, completion_tokens: u64) -> VeilChatResult {
    VeilChatResult {
        prompt_tokens: Some(prompt_tokens),
        completion_tokens: Some(completion_tokens),
        ..VeilChatResult::default()
    }
}

#[tokio::test]
async fn a_response_anchors_the_session_and_a_prefix_rewrite_invalidates_it() {
    let directory = tempfile::tempdir().unwrap();
    let session = session_with(
        (*test_config(directory.path())).clone(),
        vec![json!({"role":"user","content":"x".repeat(9_000)})],
    );

    let heuristic = {
        let messages = session.messages.lock().await.clone();
        let state = estimate_state(&session).await;
        request_estimate(&session, &messages, &[], &state).0
    };
    assert!(!heuristic.anchored);
    assert_eq!(context_event(&session, heuristic)["source"], "heuristic");

    // The response is the measurement: the whole prompt estimate is replaced,
    // not adjusted.
    append_assistant_turn(
        &session,
        json!({"role":"assistant","content":"done"}),
        &measured(5_000, 200),
    )
    .await;
    let messages = session.messages.lock().await.clone();
    let state = estimate_state(&session).await;
    let anchored = request_estimate(&session, &messages, &[], &state).0;
    assert!(anchored.anchored);
    assert_eq!(anchored.calibrated_prompt_tokens, 5_200);
    assert_ne!(anchored.heuristic_prompt_tokens, 5_200);
    let event = context_event(&session, anchored);
    assert_eq!(event["source"], "provider");
    assert_eq!(event["confidence"], "high");
    assert_eq!(event["anchored"], true);

    // Only what was appended after the anchor is estimated.
    session
        .messages
        .lock()
        .await
        .push(json!({"role":"tool","tool_call_id":"a","content":"y".repeat(600)}));
    let messages = session.messages.lock().await.clone();
    let state = estimate_state(&session).await;
    let with_tail = request_estimate(&session, &messages, &[], &state).0;
    assert!(with_tail.anchored);
    assert!(with_tail.calibrated_prompt_tokens > 5_200);
    assert!(with_tail.calibrated_prompt_tokens < 5_200 + 600);

    // A rewritten prefix leaves the anchor describing a conversation that no
    // longer exists, so it is dropped rather than reused.
    clear_usage_anchor(&session).await;
    let state = estimate_state(&session).await;
    let cleared = request_estimate(&session, &messages, &[], &state).0;
    assert!(!cleared.anchored);
    assert_eq!(context_event(&session, cleared)["source"], "heuristic");
    assert!(session.awaiting_observed_usage.load(Ordering::SeqCst));
}

// Every request carries the protected prefix, so a reported prompt smaller than
// that prefix is measuring something else — a prefix-caching runtime reporting
// only newly evaluated tokens, say. Believing it replaced the whole estimate
// with a near-zero number, which silently disabled the semantic trigger and let
// the context grow until the provider rejected the request. The integration
// suite reproduced exactly that: 40 turns of 7,000 characters at a 32K context
// with zero compactions.
#[tokio::test]
async fn an_implausibly_small_prompt_measurement_never_becomes_the_anchor() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = (*test_config(directory.path())).clone();
    config.context_length = 32_000;
    config.protected_prompt_reserve_tokens = 2_048;
    let protected_floor = config
        .protected_prompt_reserve_tokens
        .min(config.context_length / 4);
    let session = session_with(
        config,
        vec![json!({"role":"user","content":"x".repeat(120_000)})],
    );

    let heuristic = {
        let messages = session.messages.lock().await.clone();
        let state = estimate_state(&session).await;
        request_estimate(&session, &messages, &[], &state).0
    };
    assert!(heuristic.heuristic_prompt_tokens > protected_floor);

    // Below the protected prefix: rejected, and the estimate stays heuristic,
    // which is what keeps the semantic trigger reachable.
    append_assistant_turn(
        &session,
        json!({"role":"assistant","content":"done"}),
        &measured(16, 4),
    )
    .await;
    let messages = session.messages.lock().await.clone();
    let state = estimate_state(&session).await;
    let rejected = request_estimate(&session, &messages, &[], &state).0;
    assert!(!rejected.anchored, "an implausible measurement anchored");
    assert_eq!(context_event(&session, rejected)["source"], "heuristic");
    assert!(
        rejected.calibrated_prompt_tokens
            >= crate::compaction::semantic_trigger_tokens(session.config.context_length),
        "the rejected anchor must leave the trigger reachable",
    );

    // At or above the protected prefix it is a real measurement again.
    append_assistant_turn(
        &session,
        json!({"role":"assistant","content":"done"}),
        &measured(protected_floor + 1, 10),
    )
    .await;
    let messages = session.messages.lock().await.clone();
    let state = estimate_state(&session).await;
    let accepted = request_estimate(&session, &messages, &[], &state).0;
    assert!(accepted.anchored, "a plausible measurement was refused");
    assert_eq!(accepted.calibrated_prompt_tokens, protected_floor + 11);

    // Rejecting the size must not leave the session waiting forever. The
    // sentinel exists to stop a heuristic estimate from compacting twice before
    // the next response; that response has now arrived either way, and holding
    // the sentinel would block compaction for the rest of the session.
    clear_usage_anchor(&session).await;
    assert!(!semantic_compaction_allowed(&session, false));
    set_usage_anchor(&session, &measured(16, 4), 0).await;
    assert!(
        semantic_compaction_allowed(&session, false),
        "an implausible measurement must still end the wait",
    );
    assert!(session.usage_anchor.lock().await.is_none());
}

#[tokio::test]
async fn a_stale_estimate_cannot_compact_twice_before_the_next_measurement() {
    let directory = tempfile::tempdir().unwrap();
    let session = session_with((*test_config(directory.path())).clone(), Vec::new());
    assert!(semantic_compaction_allowed(&session, false));

    clear_usage_anchor(&session).await;
    assert!(
        !semantic_compaction_allowed(&session, false),
        "a heuristic estimate must not re-trigger compaction while awaiting a measurement",
    );
    // A fresh measurement, whatever it says, ends the wait.
    assert!(semantic_compaction_allowed(&session, true));
    set_usage_anchor(&session, &measured(1_000, 10), 0).await;
    assert!(semantic_compaction_allowed(&session, false));
}

#[tokio::test]
async fn two_measured_verdicts_stop_auto_compaction_and_the_event_says_so() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = (*test_config(directory.path())).clone();
    config.context_length = 10_000;
    let session = session_with(config, Vec::new());
    // context_length 10_000 ⇒ the semantic trigger sits at 7_200 tokens.
    for _ in 0..MAX_COMPACTION_STRIKES {
        clear_usage_anchor(&session).await;
        record_compaction_verdict(&session, &measured(9_000, 10)).await;
    }
    assert_eq!(
        session.compaction_strikes.load(Ordering::SeqCst),
        MAX_COMPACTION_STRIKES
    );
    assert!(!semantic_compaction_allowed(&session, true));
    let event = observed_context_event(
        &session,
        &measured(9_000, 10),
        1_000,
        ContextBreakdown::default(),
    )
    .unwrap();
    assert_eq!(event["compactionBlocked"], true);

    // A measurement that finally lands under the trigger clears the breaker.
    clear_usage_anchor(&session).await;
    record_compaction_verdict(&session, &measured(3_000, 10)).await;
    assert_eq!(session.compaction_strikes.load(Ordering::SeqCst), 0);
    assert!(semantic_compaction_allowed(&session, true));

    // A verdict is only rendered against the compaction that is awaiting one.
    record_compaction_verdict(&session, &measured(9_000, 10)).await;
    assert_eq!(session.compaction_strikes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn overflow_recovery_resolves_without_a_summarization_call() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = (*test_config(directory.path())).clone();
    config.context_length = 4_000;
    config.protected_prompt_reserve_tokens = 0;
    let mut history = vec![json!({"role":"user","content":"original request"})];
    for index in 0..6 {
        history.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":format!("call-{index}"),"type":"function","function":{"name":"read","arguments":"{}"}}]}));
        history.push(json!({"role":"tool","tool_call_id":format!("call-{index}"),"content":format!("result {index}: {}", "x".repeat(4_000))}));
    }
    let session = session_with(config, history);
    set_usage_anchor(&session, &measured(3_000, 10), 1).await;

    // The provider is unreachable in tests, so a recovery that depended on a
    // Veil summarization call could not succeed at all.
    assert!(recover_from_overflow(&session, &[]).await);
    assert!(
        session.durable_summary.lock().await.is_none(),
        "overflow recovery must not produce a semantic summary",
    );
    assert!(session.usage_anchor.lock().await.is_none());
    assert!(session.awaiting_observed_usage.load(Ordering::SeqCst));
}

#[tokio::test]
async fn the_prune_tier_folds_stale_tool_results_and_honours_the_reclaim_gate() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = (*test_config(directory.path())).clone();
    config.context_length = 16_000;
    config.protected_prompt_reserve_tokens = 0;
    let session = session_with(config, Vec::new());
    let state = SessionEstimateState::default();

    let mut messages = vec![json!({"role":"user","content":"original request"})];
    for index in 0..8 {
        messages.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":format!("call-{index}"),"type":"function","function":{"name":"read","arguments":format!("{{\"path\":\"src/file-{index}.rs\"}}")}}]}));
        messages.push(json!({"role":"tool","tool_call_id":format!("call-{index}"),"content":format!("result {index}: {}", "x".repeat(6_000))}));
    }
    messages.push(json!({"role":"user","content":"latest request"}));
    let protected = messages.last().cloned().unwrap();
    assert!(prune_stale_tool_results(
        &session,
        &mut messages,
        &[],
        &state
    ));
    assert_eq!(
        messages.last(),
        Some(&protected),
        "the protected tail is never pruned",
    );
    assert!(
        !messages
            .iter()
            .any(|message| message["tool_call_id"] == "call-0"),
        "the oldest exchange goes first",
    );
    assert!(messages.iter().any(|message| {
        message["content"]
            .as_str()
            .is_some_and(|content| content.starts_with(TOOL_HISTORY_SUMMARY_PREFIX))
    }));
    for (index, message) in messages.iter().enumerate() {
        if message["role"] == "tool" {
            assert!(index > 0 && messages[index - 1].get("tool_calls").is_some());
        }
    }

    // Over the trigger, but the only foldable evidence is trivial: rewriting
    // the prefix would break the runtime's prefix cache to reclaim nothing.
    let mut incompressible = vec![
        json!({"role":"user","content":"x".repeat(40_000)}),
        json!({"role":"assistant","content":null,"tool_calls":[{"id":"a","type":"function","function":{"name":"read","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"a","content":"tiny result"}),
        json!({"role":"user","content":"latest request"}),
    ];
    let unchanged = incompressible.clone();
    assert!(!prune_stale_tool_results(
        &session,
        &mut incompressible,
        &[],
        &state
    ));
    assert_eq!(incompressible, unchanged);
}

#[test]
fn the_compaction_source_carries_a_deterministic_file_list() {
    let messages = vec![
        json!({"role":"assistant","content":null,"tool_calls":[
            {"id":"a","type":"function","function":{"name":"read","arguments":"{\"path\":\"packages/runner/src/context.rs\"}"}},
            {"id":"b","type":"function","function":{"name":"write","arguments":"{\"path\":\"packages/runner/src/session.rs\"}"}}
        ]}),
        json!({"role":"tool","tool_call_id":"a","content":"contents"}),
        json!({"role":"tool","tool_call_id":"b","content":"written"}),
        json!({"role":"assistant","content":null,"tool_calls":[
            {"id":"c","type":"function","function":{"name":"read","arguments":"{\"path\":\"packages/runner/src/context.rs\"}"}}
        ]}),
        json!({"role":"tool","tool_call_id":"c","content":"contents"}),
    ];
    let carrier = file_list_carrier(&messages).unwrap();
    let content = carrier["content"].as_str().unwrap();
    assert!(content.starts_with(SEMANTIC_FILES_PREFIX));
    assert!(content.contains("Read: packages/runner/src/context.rs"));
    assert!(content.contains("Modified: packages/runner/src/session.rs"));
    // Paths come from the runner's own calls, so a repeat read is one entry.
    assert_eq!(content.matches("packages/runner/src/context.rs").count(), 1);

    let (source, carriers) = compaction_source(&messages);
    assert_eq!(source.len(), messages.len() + carriers.len());
    assert!(carriers.contains(&carrier));

    // A prefix with no tool calls contributes no file list at all.
    assert!(file_list_carrier(&[json!({"role":"user","content":"hello"})]).is_none());
}

// A guided tour can fill the whole window with tool results inside a single
// turn, where the semantic tiers cannot cut (everything is in the protected
// tail). After a provider 413, recovery must fold exchanges until the estimate
// has real headroom — the old single-fold nibble lost its one retry and failed
// the live run.
#[tokio::test]
async fn overflow_recovery_folds_exchanges_until_the_estimate_has_headroom() {
    let directory = tempfile::tempdir().unwrap();
    let session = test_session(directory.path());
    {
        let mut messages = session.messages.lock().await;
        messages.push(json!({"role":"user","content":"tell me more about this folder"}));
        for index in 0..12 {
            let id = format!("call-{index}");
            messages.push(json!({
                "role": "assistant",
                "content": Value::Null,
                "tool_calls": [{
                    "id": id,
                    "type": "function",
                    "function": {"name": "read", "arguments": "{\"path\":\"big.rs\"}"}
                }]
            }));
            messages.push(json!({
                "role": "tool",
                "tool_call_id": format!("call-{index}"),
                "content": "x".repeat(30_000)
            }));
        }
    }

    assert!(recover_from_overflow(&session, &[]).await);

    let state = crate::context_events::estimate_state(&session).await;
    let messages = session.messages.lock().await;
    let estimate = crate::context_events::request_estimate(&session, &messages, &[], &state)
        .0
        .heuristic_prompt_tokens;
    let target = crate::compaction::semantic_trigger_tokens(session.config.context_length);
    assert!(
        estimate <= target,
        "estimate {estimate} still above the recovery target {target}"
    );
    // Oldest-first folding keeps the most recent evidence available to the
    // model rather than erasing the whole turn.
    assert!(
        messages
            .iter()
            .any(|message| message.get("role").and_then(Value::as_str) == Some("tool")),
        "recovery must not fold every exchange when the target is already met"
    );
}

#[tokio::test]
async fn a_steer_joins_the_running_turn_instead_of_restarting_it() {
    // The step boundary is the contract: whatever the model was doing has
    // already landed in the conversation, and the steer reads as the next thing
    // the user said rather than as a new run.
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let sink = crate::session::test_sink(directory.path());
    let mut events = sink.subscribe();

    session.messages.lock().await.extend([
        json!({"role":"user","content":"find the bug"}),
        json!({"role":"assistant","content":"","tool_calls":[]}),
        json!({"role":"tool","tool_call_id":"call-1","content":"search: ok"}),
    ]);
    let accepted = {
        let mut queue = session.queue.lock().await;
        queue.enqueue(
            &session.task_id,
            &session.id,
            Some("run-1"),
            crate::run_queue::QueueAction::Steer,
            "steer-1",
            vec![crate::session::InputPart::Text {
                text: "check the tests too".into(),
            }],
        )
    };
    assert_eq!(
        accepted.disposition,
        crate::run_queue::QueueDisposition::Accepted
    );
    // Accepting a steer must not abort: the run keeps going and the tool call
    // that was in flight is never interrupted.
    assert!(!session.is_aborted());

    apply_pending_steer(&session, &sink, "run-1").await;

    let messages = session.messages.lock().await.clone();
    assert_eq!(messages.len(), 4, "the steer is appended, nothing replaced");
    assert_eq!(messages[3]["role"], "user");
    assert!(
        messages[3]["content"]
            .to_string()
            .contains("check the tests too")
    );
    // Earlier evidence survives, which is the point of not restarting.
    assert_eq!(messages[2]["content"], "search: ok");

    let observed = std::iter::from_fn(|| events.try_recv().ok()).collect::<Vec<_>>();
    let queue_events = observed
        .iter()
        .filter(|event| event["type"] == "run.queue.updated")
        .collect::<Vec<_>>();
    assert_eq!(queue_events.len(), 1);
    // "applied" tells the client the runner already placed it; only "dequeued"
    // asks the client to start a turn.
    assert_eq!(queue_events[0]["disposition"], "applied");
    assert_eq!(queue_events[0]["actionId"], "steer-1");
    assert_eq!(queue_events[0]["pendingSteer"], false);
    // Absorbing a steer is not the assistant speaking and not a new plan, so it
    // produces no status sentence of its own.
    assert!(
        !observed
            .iter()
            .any(|event| event["type"] == "assistant.progress.delta"
                || event["type"] == "assistant.delta"),
        "a steer must not emit assistant or progress text"
    );

    // The steer is consumed exactly once.
    apply_pending_steer(&session, &sink, "run-1").await;
    assert_eq!(session.messages.lock().await.len(), 4);
}

#[tokio::test]
async fn a_follow_up_never_joins_a_running_turn() {
    // Follow-ups are new requests. Mid-run injection is reserved for steers, so
    // take_steer must not reach past a queued follow-up.
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let sink = crate::session::test_sink(directory.path());
    {
        let mut queue = session.queue.lock().await;
        queue.enqueue(
            &session.task_id,
            &session.id,
            Some("run-1"),
            crate::run_queue::QueueAction::FollowUp,
            "follow-1",
            Vec::new(),
        );
    }
    apply_pending_steer(&session, &sink, "run-1").await;
    assert!(session.messages.lock().await.is_empty());
    let queue = session.queue.lock().await;
    assert_eq!(queue.follow_up_count(), 1, "the follow-up is still queued");
}
