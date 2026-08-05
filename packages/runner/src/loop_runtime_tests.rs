use super::*;
use std::sync::Arc;

use crate::{context::SessionContextStore, session::test_config};

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
            {"id":format!("call-{index}-b"),"type":"function","function":{"name":"grep","arguments":"{}"}}
        ]}));
        messages.push(json!({"role":"tool","tool_call_id":format!("call-{index}-a"),"content":format!("read result {index}")}));
        messages.push(json!({"role":"tool","tool_call_id":format!("call-{index}-b"),"content":format!("grep result {index}")}));
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
    assert!(summary.contains("read result 0") && summary.contains("grep result 0"));
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

#[test]
fn observed_usage_does_not_double_count_protected_prompts_or_completion() {
    let usage = observed_context_usage(64_000, 4_096, 12_000, 800);
    assert_eq!(usage["contentTokens"], 12_000);
    assert_eq!(usage["completionTokens"], 800);
    assert_eq!(usage["reserveTokens"], 4_096);
    assert_eq!(usage["estimatedTokens"], 16_096);
    assert_eq!(usage["phase"], "observed");
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
    let (_, anchor) = compaction_source(&messages);
    let encoded = serde_json::to_string(&anchor.unwrap()).unwrap();
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
        context_calibration: tokio::sync::Mutex::new(None),
        context_store: tokio::sync::Mutex::new(SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: crate::skill_preflight::SharedSkillCache::default(),
        run: std::sync::Mutex::new(None),
        search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
        previous_bucket: std::sync::Mutex::new(None),
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
        context_calibration: tokio::sync::Mutex::new(None),
        context_store: tokio::sync::Mutex::new(SessionContextStore::default()),
        lsp: None,
        workspace_graph: None,
        skill_cache: crate::skill_preflight::SharedSkillCache::default(),
        run: std::sync::Mutex::new(None),
        search_index: std::sync::Arc::new(crate::tools::SearchIndex::default()),
        previous_bucket: std::sync::Mutex::new(None),
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
        !attempt_semantic_compaction(&session, &mut messages, &[]).await,
        "compaction must not run inside an active step",
    );
}
