use super::*;
use crate::config::MtlsConfig;

#[test]
fn preparation_is_bounded_metadata_once_per_file_call() {
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let sink = crate::session::test_sink(directory.path());
    let mut events = sink.subscribe();
    let partial = [
        "write",
        "edit",
        "apply_patch",
        "artifact",
        "read",
        "command",
    ]
    .into_iter()
    .enumerate()
    .map(|(index, name)| {
        (
            index,
            (
                format!("call-{index}"),
                name.into(),
                "private file contents".into(),
            ),
        )
    })
    .collect();
    let mut preparing = std::collections::BTreeSet::new();
    emit_tool_preparation(&sink, &session, &partial, &mut preparing);
    emit_tool_preparation(&sink, &session, &partial, &mut preparing);
    let observed: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
    assert_eq!(observed.len(), 4);
    for event in observed {
        assert_eq!(event["type"], "tool.preparing");
        assert_eq!(event.as_object().unwrap().len(), 5);
        assert!(!event.to_string().contains("private file contents"));
    }
}

#[test]
fn live_text_is_the_answer() {
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let sink = crate::session::test_sink(directory.path());
    let mut events = sink.subscribe();

    assert!(emit_delta(&sink, &session, "The config sets three limits."));
    let delta = events.try_recv().unwrap();
    assert_eq!(delta["type"], "assistant.delta");
    assert_eq!(delta["text"], "The config sets three limits.");

    assert!(!emit_delta(&sink, &session, ""));
    assert!(events.try_recv().is_err());
}

#[test]
fn visible_reasoning_is_tagged_thinking_and_tool_preambles_are_not() {
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let sink = crate::session::test_sink(directory.path());
    let mut events = sink.subscribe();

    assert!(emit_progress(
        &sink,
        &session,
        "I will map the repository.",
        None
    ));
    assert!(emit_progress(
        &sink,
        &session,
        "the user asked for a tour",
        Some("thinking"),
    ));

    let observed: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).collect();
    assert_eq!(observed.len(), 2);
    assert_eq!(observed[0]["type"], "assistant.progress.delta");
    assert_eq!(observed[0]["text"], "I will map the repository.");
    assert!(observed[0].get("kind").is_none());
    assert_eq!(observed[1]["kind"], "thinking");
    assert_eq!(observed[1]["text"], "the user asked for a tour");
}

#[test]
fn tool_deltas_accumulate_by_index() {
    let mut result = VeilChatResult::default();
    let mut calls = BTreeMap::new();
    append_veil_delta(&mut result, json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{\"pa"}}]}).as_object().unwrap(), &mut calls);
    append_veil_delta(
        &mut result,
        json!({"tool_calls":[{"index":0,"function":{"arguments":"th\":\"README.md\"}"}}]})
            .as_object()
            .unwrap(),
        &mut calls,
    );
    assert_eq!(
        result.tool_calls[0].arguments.as_str(),
        Some("{\"path\":\"README.md\"}")
    );
}
#[test]
fn split_multibyte_utf8_is_preserved_until_a_complete_line() {
    let source = "data: {\"choices\":[{\"delta\":{\"content\":\"café\"}}]}\n";
    let bytes = source.as_bytes();
    let split = source.find('é').unwrap() + 1;
    let mut buffer = Vec::new();
    assert!(
        complete_utf8_lines(&mut buffer, &bytes[..split])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        complete_utf8_lines(&mut buffer, &bytes[split..]).unwrap(),
        [source.trim_end()]
    );
    assert!(buffer.is_empty());
}

#[test]
fn sse_data_accepts_optional_space_after_field_name() {
    assert_eq!(sse_data("data: [DONE]"), Some("[DONE]"));
    assert_eq!(sse_data("data:[DONE]"), Some("[DONE]"));
    assert_eq!(sse_data("event: error"), None);
}

#[test]
fn veil_failures_are_specific_without_echoing_untrusted_response_bodies() {
    let payload = json!({
        "error": "provider leaked prompt content",
        "code": "model_service_rejected",
        "upstreamStatus": 500
    });
    let message = veil_failure_message(Some(502), Some(&payload));
    assert_eq!(
        message,
        "the model service rejected the request (upstream status 500, Veil status 502)"
    );
    assert!(!message.contains("leaked"));

    let stream = "data: {\"error\":\"hidden detail\",\"code\":\"model_service_stream_incomplete\"}";
    let error = veil_stream_error(stream).expect("an error frame");
    assert_eq!(
        error.message,
        "model request failed: the model service stream ended unexpectedly"
    );
}

#[test]
fn a_runtime_that_went_away_mid_stream_is_retried_and_a_refusal_is_not() {
    // The runtime dying after Veil opened the stream arrives as an error frame,
    // not a status. Nothing was committed, so it is the same case as a dropped
    // socket and gets the same retry.
    for code in [
        "model_service_stream_incomplete",
        "model_service_unavailable",
        "model_service_timeout",
    ] {
        let line = format!("data: {{\"error\":\"x\",\"code\":\"{code}\"}}");
        assert!(veil_stream_error(&line).unwrap().retryable, "{code}");
    }
    // Anything else in an error frame is Veil's considered answer.
    for code in [
        "model_service_rejected",
        "context_overflow_upstream",
        "policy_denied",
        "",
    ] {
        let line = format!("data: {{\"error\":\"x\",\"code\":\"{code}\"}}");
        assert!(!veil_stream_error(&line).unwrap().retryable, "{code:?}");
    }
    assert!(veil_stream_error("data: {\"choices\":[]}").is_none());
}

#[test]
fn total_only_usage_completes_a_partial_provider_measurement() {
    let mut result = VeilChatResult {
        prompt_tokens: Some(1200),
        ..VeilChatResult::default()
    };
    update_usage(&mut result, &json!({"total_tokens": 1300}));
    assert_eq!(result.prompt_tokens, Some(1200));
    assert_eq!(result.completion_tokens, Some(100));
    // A runtime that reports no protected-prefix size leaves the runner on
    // its configured stand-in rather than on a zero.
    assert_eq!(result.system_prompt_tokens, None);

    let mut result = VeilChatResult {
        completion_tokens: Some(100),
        ..VeilChatResult::default()
    };
    update_usage(&mut result, &json!({"total_tokens": 1300}));
    assert_eq!(result.prompt_tokens, Some(1200));
    assert_eq!(result.completion_tokens, Some(100));

    update_usage(
        &mut result,
        &json!({"prompt_tokens": 1200, "completion_tokens": 100, "system_prompt_tokens": 3187, "system_prompt_tokens_exact": true}),
    );
    assert_eq!(result.system_prompt_tokens, Some(3187));
    assert!(result.system_prompt_tokens_exact);

    // A size without an exactness claim is treated as an estimate.
    let mut result = VeilChatResult::default();
    update_usage(&mut result, &json!({"system_prompt_tokens": 800}));
    assert_eq!(result.system_prompt_tokens, Some(800));
    assert!(!result.system_prompt_tokens_exact);
}

#[test]
fn complete_stream_lines_reject_invalid_utf8() {
    let mut buffer = Vec::new();
    assert_eq!(
        complete_utf8_lines(&mut buffer, b"data: \xff\n").unwrap_err(),
        "model stream contained invalid UTF-8"
    );
}

#[test]
fn stream_lines_and_json_are_bounded_and_strict() {
    let mut buffer = Vec::new();
    assert!(
        complete_utf8_lines(&mut buffer, &vec![b'x'; 4 * 1024 * 1024 + 1])
            .unwrap_err()
            .contains("4 MiB")
    );
    buffer.clear();
    let mut complete_oversized = vec![b'x'; 4 * 1024 * 1024 + 1];
    complete_oversized.push(b'\n');
    assert!(
        complete_utf8_lines(&mut buffer, &complete_oversized)
            .unwrap_err()
            .contains("4 MiB")
    );
    let mut result = VeilChatResult::default();
    let mut partial = BTreeMap::new();
    assert_eq!(
        process_veil_line("data: not-json", &mut result, &mut partial).unwrap_err(),
        "Veil stream contained invalid JSON"
    );
}

#[test]
fn missing_tool_call_ids_are_created_without_hiding_duplicates() {
    let mut calls = vec![
        ToolCall {
            id: "same".into(),
            name: "read".into(),
            arguments: json!({}),
            index: 0,
        },
        ToolCall {
            id: "same".into(),
            name: "read".into(),
            arguments: json!({}),
            index: 1,
        },
        ToolCall {
            id: "".into(),
            name: "read".into(),
            arguments: json!({}),
            index: 2,
        },
    ];
    fill_missing_tool_call_ids(&mut calls);
    assert_eq!(calls[0].id, calls[1].id);
    assert_eq!(calls[2].id, "tool-call-2");
}

fn provider_with_mtls(mtls: MtlsConfig) -> ProviderConfig {
    ProviderConfig {
        id: "company-endpoint".into(),
        name: "test".into(),
        base_url: "https://127.0.0.1".into(),
        mode: crate::config::ProviderMode::Local,
        chat_endpoint_path: Some("/v1/chat/completions".into()),
        api_key: std::sync::Arc::new(std::sync::RwLock::new(String::new())),
        model_id: "test".into(),
        send_model_field: false,
        send_thinking_field: false,
        thinking: None,
        send_reasoning_visible_field: false,
        reasoning_visible: false,
        veil_web_search: false,
        image_generation: false,
        headers: BTreeMap::new(),
        mtls: Some(mtls),
    }
}

#[test]
fn mtls_pem_identity_requires_a_certificate_and_key_pair() {
    let cert_only = provider_with_mtls(MtlsConfig {
        cert_path: Some("client.pem".into()),
        ..MtlsConfig::default()
    });
    assert!(
        client_for(&cert_only)
            .unwrap_err()
            .contains("certPath and keyPath")
    );
}

// The other direction of the wire-compatibility contract in the root AGENTS.md:
// a harness must survive a NEWER Veil. Veil responses are read field by field
// off untyped JSON, and SSE lines that are not `data:` are skipped, so a server
// that adds fields or event kinds cannot break a build that predates them.
#[test]
fn a_newer_veil_stream_does_not_break_this_runner() {
    let mut result = VeilChatResult::default();
    let mut calls = BTreeMap::new();

    // Unknown SSE event kinds and comment lines are not `data:` and are skipped.
    for line in [
        "event: veil.checkpoint",
        ": keep-alive",
        "id: 42",
        "retry: 1000",
    ] {
        let (done, content, _) = process_veil_line(line, &mut result, &mut calls).unwrap();
        assert!(!done, "{line} must not end the stream");
        assert!(content.is_empty(), "{line} must contribute no content");
    }

    // Unknown fields alongside the ones this build reads are ignored, and the
    // content still arrives.
    let (_, content, reasoning) = process_veil_line(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\",\"reasoning_content\":\"hidden\",\"annotations\":[{\"kind\":\"cite\"}]},\"logprobs\":null}],\"veilTrace\":{\"span\":\"abc\"},\"serverHints\":{\"cacheWarm\":true}}",
        &mut result,
        &mut calls,
    )
    .unwrap();
    assert_eq!(content, "hi");
    assert_eq!(reasoning, "hidden");
    assert!(
        !result.content.contains("hidden"),
        "reasoning must not join the answer"
    );

    let (done, _, _) = process_veil_line("data: [DONE]", &mut result, &mut calls).unwrap();
    assert!(done);
}

/// The wire contract for the composer's two new controls. Both fields are
/// opt-in: a body that carries neither is the body this runner has always sent.
mod chat_body {
    use super::*;
    use crate::{config::RunnerConfig, veil_request::chat_request_body};
    use serde_json::json;
    use std::sync::Arc;

    fn config(
        send_model_field: bool,
        thinking: Option<&str>,
        send_thinking_field: bool,
    ) -> Arc<RunnerConfig> {
        let directory = std::env::temp_dir();
        let mut config = (*crate::session::test_config(&directory)).clone();
        config.provider.model_id = "qwen3-32b".into();
        config.provider.send_model_field = send_model_field;
        config.provider.send_thinking_field = send_thinking_field;
        config.provider.thinking = thinking.map(str::to_owned);
        config.provider.send_reasoning_visible_field = false;
        config.provider.reasoning_visible = false;
        Arc::new(config)
    }

    fn body(
        send_model_field: bool,
        thinking: Option<&str>,
        send_thinking_field: bool,
    ) -> serde_json::Map<String, Value> {
        let config = config(send_model_field, thinking, send_thinking_field);
        chat_request_body(
            &config,
            &[json!({"role":"user","content":"hi"})],
            &[],
            1024,
            false,
        )
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn the_model_is_named_only_when_the_desktop_confirmed_the_feature() {
        let sent = body(true, None, false);
        assert_eq!(sent["model"], json!("qwen3-32b"));
        assert_eq!(sent["stream"], json!(true));
        assert!(!body(false, None, false).contains_key("model"));
    }

    #[test]
    fn thinking_is_named_only_when_the_desktop_confirmed_the_feature() {
        assert!(!body(false, Some("off"), false).contains_key("thinking"));
        assert!(!body(false, None, true).contains_key("thinking"));
        let off = body(false, Some("off"), true);
        assert_eq!(off["thinking"], json!("off"));
        assert!(!off.contains_key("model"));
        assert_eq!(body(false, Some("on"), true)["thinking"], json!("on"));
    }

    #[test]
    fn reasoning_visible_is_named_only_when_the_desktop_confirmed_the_feature() {
        let body_of = |send: bool, visible: bool| {
            let mut config = (*crate::session::test_config(&std::env::temp_dir())).clone();
            config.provider.send_reasoning_visible_field = send;
            config.provider.reasoning_visible = visible;
            chat_request_body(
                &config,
                &[json!({"role":"user","content":"hi"})],
                &[],
                1024,
                false,
            )
            .as_object()
            .unwrap()
            .clone()
        };
        assert!(!body_of(false, true).contains_key("reasoning_visible"));
        assert!(!body_of(true, false).contains_key("reasoning_visible"));
        assert_eq!(body_of(true, true)["reasoning_visible"], json!(true));
    }
}
