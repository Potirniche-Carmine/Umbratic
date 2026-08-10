use super::*;
use crate::config::MtlsConfig;

// Veil owns the bucket catalog, so "may this turn answer without tools?"
// arrives as a resolved flag. It is additive: a Veil that predates it still
// parses, and the run simply keeps today's behavior.
#[test]
fn an_orient_decision_carries_veils_evidence_requirement() {
    let guided = parse_orient_payload(
        &json!({"bucket":"repo_orient","summarySentence":"I will map this repository.","evidenceRequired":true}),
    )
    .unwrap();
    assert_eq!(guided.bucket, "repo_orient");
    assert!(guided.evidence_required);
    assert_eq!(
        guided.summary_sentence.as_deref(),
        Some("I will map this repository.")
    );

    let optional = parse_orient_payload(
        &json!({"bucket":"spec_discovery","summarySentence":null,"evidenceRequired":false}),
    )
    .unwrap();
    assert!(!optional.evidence_required);
    assert!(optional.summary_sentence.is_none());

    // Absent flag, older Veil: the rule cannot fire, and nothing degrades.
    let legacy =
        parse_orient_payload(&json!({"bucket":"repo_orient","summarySentence":null})).unwrap();
    assert!(!legacy.evidence_required);

    // direct_answer never guides a run, so it never requires evidence.
    let direct = parse_orient_payload(
        &json!({"bucket":"direct_answer","summarySentence":null,"evidenceRequired":true}),
    )
    .unwrap();
    assert!(!direct.evidence_required);

    // The key set stays closed: an unexpected field is still a rejection.
    assert!(parse_orient_payload(&json!({"bucket":"repo_orient","playbook":"do this"})).is_err());
}

// Holding text until the step resolves is what lets the runner say which kind
// of prose it was without ever moving it after the fact. The two release sites
// are the whole classification: tool calls mean the text was a preamble, no
// tool calls mean it was the answer.
#[test]
fn a_released_step_says_whether_its_text_was_narration_or_the_answer() {
    let directory = tempfile::tempdir().unwrap();
    let session = crate::session::test_session(directory.path());
    let sink = crate::session::test_sink(directory.path());
    let mut events = sink.subscribe();

    let mut preamble = VeilChatResult {
        held_text: "I'll read the config first.".into(),
        ..VeilChatResult::default()
    };
    release_held_narration(&sink, &session, &mut preamble);
    let narration = events.try_recv().unwrap();
    assert_eq!(narration["type"], "assistant.progress.delta");
    assert_eq!(narration["text"], "I'll read the config first.");
    // Released means released: nothing is left to emit a second time.
    assert!(preamble.held_text.is_empty());

    let mut answer = VeilChatResult {
        held_text: "The config sets three limits.".into(),
        ..VeilChatResult::default()
    };
    release_held_text(&sink, &session, &mut answer);
    let delta = events.try_recv().unwrap();
    assert_eq!(delta["type"], "assistant.delta");
    assert_eq!(delta["text"], "The config sets three limits.");

    // A step that held nothing says nothing, so a refused step still leaves no
    // trace in the UI.
    let mut empty = VeilChatResult::default();
    release_held_narration(&sink, &session, &mut empty);
    assert!(events.try_recv().is_err());
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
    assert_eq!(
        veil_stream_error(stream).as_deref(),
        Some("model request failed: the model service stream ended unexpectedly")
    );
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
        let (done, content) = process_veil_line(line, &mut result, &mut calls).unwrap();
        assert!(!done, "{line} must not end the stream");
        assert!(content.is_empty(), "{line} must contribute no content");
    }

    // Unknown fields alongside the ones this build reads are ignored, and the
    // content still arrives.
    let (_, content) = process_veil_line(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\",\"annotations\":[{\"kind\":\"cite\"}]},\"logprobs\":null}],\"veilTrace\":{\"span\":\"abc\"},\"serverHints\":{\"cacheWarm\":true}}",
        &mut result,
        &mut calls,
    )
    .unwrap();
    assert_eq!(content, "hi");

    let (done, _) = process_veil_line("data: [DONE]", &mut result, &mut calls).unwrap();
    assert!(done);
}
