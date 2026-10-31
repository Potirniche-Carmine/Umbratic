use super::*;
#[test]
fn allocation_free_json_length_matches_serde_json_encoding() {
    let values = vec![
        serde_json::json!(null),
        serde_json::json!(true),
        serde_json::json!(123.5),
        serde_json::json!("quote \" slash \\ controls \n \u{0001} unicode 中🙂"),
        serde_json::json!({"key":"value","nested":[1,false,null]}),
    ];
    for value in &values {
        assert_eq!(
            encoded_json_len(value),
            serde_json::to_vec(value).unwrap().len(),
            "{value}"
        );
    }
    assert_eq!(
        encoded_json_array_len(&values),
        serde_json::to_vec(&values).unwrap().len()
    );
}

#[test]
fn large_output_is_stored_and_retrievable() {
    let mut store = SessionContextStore::default();
    let source = "line of output\n".repeat(2000);
    let result = compress_tool_result(
        &mut store, "read", "file", "call", "read BIG", &source, "success",
    );
    assert!(result.modified);
    let hash = result.marker_hash.unwrap();
    let first = store.retrieve(&hash, None, Some(100)).unwrap();
    assert_eq!(first.offset, 0);
    assert_eq!(first.content, source[..first.bytes_shown]);
    assert_eq!(first.total_bytes, source.len());
    assert_eq!(first.next_offset, Some(first.bytes_shown));

    let second = store.retrieve(&hash, first.next_offset, Some(100)).unwrap();
    assert_eq!(second.offset, first.bytes_shown);
    assert_eq!(
        second.content,
        source[second.offset..second.offset + second.bytes_shown]
    );
    assert_eq!(store.stats(), (1, source.len()));
}

#[test]
fn retrieval_offsets_preserve_utf8_boundaries_and_limits() {
    let mut store = SessionContextStore::default();
    let source = "é".repeat(20_000);
    let result = compress_tool_result(
        &mut store, "read", "file", "call", "unicode", &source, "success",
    );
    let window = store
        .retrieve(&result.marker_hash.unwrap(), Some(1), Some(17))
        .unwrap();
    assert_eq!(window.offset, 2);
    assert!(window.content.is_char_boundary(window.content.len()));
    assert!(window.bytes_shown <= 17);
}

#[test]
fn head_tail_compression_preserves_both_ends_and_errors() {
    let middle = "middle line with enough padding to consume bytes\n".repeat(500);
    let source = format!("first line\n{middle}fatal: final failure\nlast line");
    let body = text_head_tail(&source, "Log compressed.", true);
    assert!(body.len() <= MAX_DISPLAYED_BYTES);
    assert!(body.contains("first line"));
    assert!(body.contains("fatal: final failure"));
    assert!(body.contains("last line"));
}

#[test]
fn compaction_uses_the_declared_kind_not_the_output_text() {
    // A command whose output happens to look like a diff is still a log.
    let mut store = SessionContextStore::default();
    let source = format!("diff --git a/a b/a{}", "+next".repeat(MIN_COMPRESS_BYTES));
    let result = compress_tool_result(
        &mut store, "command", "log", "call", "cmd", &source, "success",
    );
    assert_eq!(result.kind, "log");
}

#[test]
fn json_compression_samples_both_ends_structurally() {
    let source = serde_json::to_string(
        &(0..100)
            .map(|index| serde_json::json!({"index":index,"payload":"x".repeat(1000)}))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let body = json_sample(&serde_json::from_str(&source).unwrap());
    assert!(body.contains("0: {"));
    assert!(body.contains("99: {"));
    assert!(body.contains("Total entries: 100"));
    assert!(body.len() <= MAX_DISPLAYED_BYTES);
}

#[test]
fn context_estimate_matches_veil_json_accounting_and_handles_images_conservatively() {
    let messages = vec![serde_json::json!({"role":"user","content":[
        {"type":"text","text":"你好🙂"},
        {"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}", "A".repeat(100_000))}}
    ]})];
    let usage = estimate_context_usage(estimate_input(&messages, 64_000, 4_096));
    let veil_value_tokens = serde_json::to_vec(&messages).unwrap().len().div_ceil(3) as u64
        + serde_json::to_vec(&Vec::<serde_json::Value>::new())
            .unwrap()
            .len()
            .div_ceil(3) as u64;
    assert_eq!(
        usage.calibrated_prompt_tokens,
        veil_value_tokens + 10 + 1_600 + 4_096
    );
    assert_eq!(usage.reserve_tokens, 4_096);
    assert!(!usage.anchored);
    assert_eq!(usage.event()["phase"], "preflight");
    assert_eq!(usage.event()["source"], "heuristic");
    assert_eq!(usage.event()["confidence"], "low");
    assert_eq!(usage.event()["anchored"], false);
    // The image is priced once, in its own row, not by the length of its
    // base64 payload in the conversation row.
    assert_eq!(usage.breakdown.image_tokens, 1_600);
    assert!(usage.breakdown.conversation_tokens < 200);
}

fn estimate_input(
    messages: &[Value],
    context_length: u64,
    protected_prompt_reserve_tokens: u64,
) -> ContextEstimateInput<'_> {
    ContextEstimateInput {
        messages,
        tools: &[],
        skills: &[],
        context_length,
        max_response_tokens: 4_096,
        protected_prompt_reserve_tokens,
        system_prompt: None,
        anchor: None,
    }
}

#[test]
fn an_anchor_replaces_the_whole_prompt_estimate_with_the_measured_size() {
    let settled = vec![
        serde_json::json!({"role":"user","content":"x".repeat(20_000)}),
        serde_json::json!({"role":"assistant","content":"done"}),
    ];
    let mut messages = settled.clone();
    messages.push(serde_json::json!({"role":"user","content":"follow up"}));
    let anchor = UsageAnchor {
        prompt_tokens: 9_000,
        completion_tokens: 120,
        anchor_len: settled.len(),
    };
    let anchored = estimate_context_usage(ContextEstimateInput {
        anchor: Some(anchor),
        ..estimate_input(&messages, 64_000, 4_096)
    });
    let tail = &messages[settled.len()..];
    let expected_tail = (serde_json::to_vec(tail).unwrap().len().div_ceil(3) as u64) + 10;
    assert!(anchored.anchored);
    assert_eq!(anchored.calibrated_prompt_tokens, 9_120 + expected_tail);
    assert_eq!(anchored.event()["source"], "provider");
    assert_eq!(anchored.event()["confidence"], "high");
    assert_eq!(anchored.event()["anchored"], true);

    // The heuristic path is untouched, and an anchor that describes more
    // messages than exist is refused rather than trusted.
    let unanchored = estimate_context_usage(estimate_input(&messages, 64_000, 4_096));
    assert_eq!(
        anchored.heuristic_prompt_tokens,
        unanchored.calibrated_prompt_tokens
    );
    let stale = estimate_context_usage(ContextEstimateInput {
        anchor: Some(UsageAnchor {
            anchor_len: messages.len() + 1,
            ..anchor
        }),
        ..estimate_input(&messages, 64_000, 4_096)
    });
    assert!(!stale.anchored);
    assert_eq!(
        stale.calibrated_prompt_tokens,
        unanchored.calibrated_prompt_tokens
    );
}

#[test]
fn a_measured_system_prompt_replaces_the_configured_stand_in() {
    let messages = vec![serde_json::json!({"role":"user","content":"request"})];
    let measured = estimate_context_usage(ContextEstimateInput {
        system_prompt: Some(SystemPromptSize {
            tokens: 3_187,
            exact: true,
        }),
        ..estimate_input(&messages, 8_000, 2_048)
    });
    assert_eq!(measured.protected_tokens, 3_187);
    assert!(measured.breakdown.system_prompt_exact);
    // Without a measurement the configured reserve is still clamped to a
    // quarter of the window.
    let stand_in = estimate_context_usage(estimate_input(&messages, 8_000, 2_048));
    assert_eq!(stand_in.protected_tokens, 2_000);
    assert!(!stand_in.breakdown.system_prompt_exact);
}

#[test]
fn breakdown_rows_separate_conversation_from_tool_results() {
    let messages = vec![
        serde_json::json!({"role":"user","content":"request"}),
        serde_json::json!({"role":"assistant","content":null,"tool_calls":[{"id":"a"}]}),
        serde_json::json!({"role":"tool","tool_call_id":"a","content":"y".repeat(3_000)}),
    ];
    let tools = vec![serde_json::json!({"name":"read"})];
    let skills = vec![serde_json::json!({"id":"docs"})];
    let breakdown = context_breakdown(
        &messages,
        &tools,
        &skills,
        SystemPromptSize {
            tokens: 100,
            exact: false,
        },
    );
    assert!(breakdown.tool_result_tokens > 900);
    assert!(breakdown.conversation_tokens < 100);
    assert!(breakdown.tool_definition_tokens > 0);
    assert!(breakdown.skill_tokens > 0);
    assert_eq!(breakdown.image_tokens, 0);
    // Rows are estimates per category and are deliberately not reconciled to
    // the headline, so nothing here asserts that they sum to it.
    assert_eq!(breakdown.system_prompt_tokens, 100);
}

#[test]
fn output_reserve_grows_to_eight_thousand_and_keeps_a_one_thousand_token_minimum() {
    assert_eq!(adaptive_output_reserve(16_000, 8_192, 8_000), 8_000);
    assert_eq!(adaptive_output_reserve(16_000, 8_192, 12_400), 3_000);
    assert_eq!(adaptive_output_reserve(16_000, 8_192, 13_400), 2_000);
    assert_eq!(adaptive_output_reserve(16_000, 8_192, 14_400), 1_000);
    assert_eq!(adaptive_output_reserve(16_000, 8_192, 15_400), 1_000);
}

#[test]
fn context_estimate_uses_the_adaptive_response_allowance() {
    let messages = vec![serde_json::json!({"role":"user","content":"x".repeat(37_000)})];
    let usage = estimate_context_usage(estimate_input(&messages, 16_000, 0));
    assert_eq!(usage.reserve_tokens, 3_000);
    assert!(usage.estimated_tokens() <= 16_000);
}

#[test]
fn calibration_is_conservative_bounded_and_profile_scoped() {
    let calibration =
        ContextCalibration::from_observation("profile-a".into(), 1_200, 1_000, 8_000).unwrap();
    assert_eq!(calibration.multiplier_milli, 1_200);
    assert_eq!(calibration.apply("profile-a", 2_000), 2_400);
    assert_eq!(calibration.apply("profile-b", 2_000), 2_000);

    let downward = ContextCalibration::from_observation("p".into(), 800, 1_000, 8_000).unwrap();
    assert_eq!(downward.multiplier_milli, 1_000);
    let upward = ContextCalibration::from_observation("p".into(), 2_000, 1_000, 8_000).unwrap();
    assert_eq!(upward.multiplier_milli, 1_500);
    assert!(ContextCalibration::from_observation("p".into(), 0, 1_000, 8_000).is_none());
    assert!(ContextCalibration::from_observation("p".into(), 8_001, 1_000, 8_000).is_none());
}

#[test]
fn calibration_arithmetic_saturates_without_overflow() {
    let calibration = ContextCalibration {
        profile_fingerprint: "p".into(),
        multiplier_milli: 1_500,
        observed_prompt_tokens: u64::MAX,
        estimated_prompt_tokens: u64::MAX,
    };
    assert_eq!(calibration.apply("p", u64::MAX), u64::MAX);
}

#[test]
fn request_profile_changes_with_tools_and_skills() {
    let base =
        request_profile_fingerprint("model", "/api/engineering/chat", 64_000, 2_048, &[], &[]);
    let tool = request_profile_fingerprint(
        "model",
        "/api/engineering/chat",
        64_000,
        2_048,
        &[serde_json::json!({"name":"read"})],
        &[],
    );
    let skill = request_profile_fingerprint(
        "model",
        "/api/engineering/chat",
        64_000,
        2_048,
        &[],
        &[serde_json::json!({"id":"docs"})],
    );
    assert_ne!(base, tool);
    assert_ne!(base, skill);
    assert_ne!(tool, skill);
}

#[test]
fn retrieval_refreshes_lru_retention() {
    let mut store = SessionContextStore::default();
    for index in 0..MAX_ENTRIES {
        let source = format!("entry {index} {}", "x".repeat(MIN_COMPRESS_BYTES));
        let result = compress_tool_result(
            &mut store,
            "read",
            "file",
            &format!("call-{index}"),
            "read",
            &source,
            "success",
        );
        assert!(result.marker_hash.is_some());
    }
    let oldest = store.order.front().cloned().unwrap();
    assert!(store.retrieve(&oldest, None, Some(10)).is_some());
    let source = format!("new entry {}", "y".repeat(MIN_COMPRESS_BYTES));
    let _ = compress_tool_result(
        &mut store, "read", "file", "new", "read", &source, "success",
    );
    assert!(store.retrieve(&oldest, None, Some(10)).is_some());
}

// A live session showed category rows summing to 23.8k under an 18.1k
// headline: raw heuristic rows over a measured total read as a broken meter.
// Rows must always sum to the reported headline, preserving proportions and
// any exact system-prompt measurement.
#[test]
fn breakdown_rows_reconcile_to_the_reported_headline() {
    let breakdown = ContextBreakdown {
        system_prompt_tokens: 3_187,
        system_prompt_exact: true,
        tool_definition_tokens: 4_000,
        skill_tokens: 2_000,
        conversation_tokens: 10_000,
        tool_result_tokens: 4_000,
        image_tokens: 0,
    };
    let reconciled = breakdown.reconciled_to(13_187);
    let sum = reconciled.system_prompt_tokens
        + reconciled.tool_definition_tokens
        + reconciled.skill_tokens
        + reconciled.conversation_tokens
        + reconciled.tool_result_tokens
        + reconciled.image_tokens;
    assert_eq!(sum, 13_187);
    // The exact system measurement is preserved, not scaled.
    assert_eq!(reconciled.system_prompt_tokens, 3_187);
    // Estimated rows keep their proportions: conversation was half of the
    // estimated mass, so it stays about half of what remains.
    assert!(
        (4_900..=5_100).contains(&reconciled.conversation_tokens),
        "conversation share drifted: {}",
        reconciled.conversation_tokens
    );

    // With nothing estimated, the unexplained remainder lands on the
    // conversation row rather than vanishing.
    let sparse = ContextBreakdown {
        system_prompt_tokens: 500,
        system_prompt_exact: true,
        ..ContextBreakdown::default()
    };
    let filled = sparse.reconciled_to(2_000);
    assert_eq!(filled.system_prompt_tokens, 500);
    assert_eq!(filled.conversation_tokens, 1_500);

    // The event path reports reconciled rows, so the meter's parts always sum
    // to its headline.
    let usage = estimate_context_usage(ContextEstimateInput {
        messages: &[serde_json::json!({"role":"user","content":"hello there"})],
        tools: &[],
        skills: &[],
        context_length: 64_000,
        max_response_tokens: 4_096,
        protected_prompt_reserve_tokens: 4_096,
        system_prompt: None,
        anchor: None,
    });
    let event = usage.event();
    let rows = [
        "systemPromptTokens",
        "toolDefinitionTokens",
        "skillTokens",
        "conversationTokens",
        "toolResultTokens",
        "imageTokens",
    ]
    .iter()
    .map(|key| event["breakdown"][key].as_u64().unwrap())
    .sum::<u64>();
    assert_eq!(rows, event["contentTokens"].as_u64().unwrap());
}

#[test]
fn json_string_byte_accounting_matches_serde_for_controls_escapes_and_unicode() {
    let ascii = (0..=127).map(char::from).collect::<String>();
    for text in [
        "",
        "plain text",
        "quotes \" and backslashes \\",
        "é你好🙂\u{2028}\u{2029}",
        "\u{7f}\u{80}\u{7ff}\u{800}\u{ffff}\u{10000}\u{10ffff}",
        ascii.as_str(),
    ] {
        assert_eq!(
            encoded_json_string_len(text),
            serde_json::to_vec(text).unwrap().len(),
            "JSON length for {text:?}"
        );
        let object = json!({(text): "value"});
        assert_eq!(
            encoded_json_len(&object),
            serde_json::to_vec(&object).unwrap().len()
        );
    }
}

#[test]
fn reused_context_counts_match_wire_encoding_rows_images_and_anchors() {
    fn wire_bytes(value: &impl serde::Serialize) -> u64 {
        serde_json::to_vec(value).unwrap().len() as u64
    }
    fn elided(value: &Value) -> Value {
        match value {
            Value::Object(fields) if fields.get("type") == Some(&json!("image_url")) => {
                // The existing breakdown prices one image node as24 JSON bytes.
                Value::String("x".repeat(22))
            }
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), elided(value)))
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.iter().map(elided).collect()),
            other => other.clone(),
        }
    }
    let text_messages = vec![
        (json!({"role":"user","content":""}), 0),
        (json!({"role":"tool","content":"a"}), 0),
        (json!({"role":"user","content":"aa"}), 0),
        (json!({"role":"tool","content":"aaa"}), 0),
        (
            json!({"role":"assistant","content":"\"\\\n\u{0001}中🙂"}),
            0,
        ),
        (json!({"role":"tool","content":{"\u{0000}中":"value"}}), 0),
        (json!(null), 0),
    ];
    let images = vec![
        (
            json!({"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}),
            1,
        ),
        (
            json!({"role":"tool","content":{"type":"image_url","image_url":{"url":"image","nested":{"type":"image_url","image_url":{"url":"nested"}}}}}),
            2,
        ),
    ];
    let views = [
        vec![],
        text_messages.clone(),
        images.clone(),
        [text_messages, images].concat(),
    ];
    let tool_sets = [
        vec![],
        vec![json!({"name":"read","description":"中\n","parameters":{"type":"object"}})],
    ];
    let skill_sets = [vec![], vec![json!({"id":"skill","description":"\"🙂"})]];
    for view in views {
        let messages = view
            .iter()
            .map(|(message, _)| message.clone())
            .collect::<Vec<_>>();
        let image_tokens = view.iter().map(|(_, count)| count).sum::<u64>() * 1_600;
        for tools in &tool_sets {
            for skills in &skill_sets {
                for measured_system in [
                    None,
                    Some(SystemPromptSize {
                        tokens: 333,
                        exact: true,
                    }),
                ] {
                    let system = measured_system.unwrap_or(SystemPromptSize {
                        tokens: 2_048,
                        exact: false,
                    });
                    let mut row_bytes = [0u64; 2];
                    let mut row_counts = [0u64; 2];
                    for message in &messages {
                        let row = usize::from(message.get("role") == Some(&json!("tool")));
                        row_bytes[row] += wire_bytes(&elided(message));
                        row_counts[row] += 1;
                    }
                    let row_tokens = |row: usize| row_bytes[row].div_ceil(3) + row_counts[row] * 10;
                    let tool_tokens = if tools.is_empty() {
                        0
                    } else {
                        wire_bytes(tools).div_ceil(3)
                    };
                    let skill_tokens = if skills.is_empty() {
                        0
                    } else {
                        wire_bytes(skills).div_ceil(3)
                    };
                    let breakdown = ContextBreakdown {
                        system_prompt_tokens: system.tokens,
                        system_prompt_exact: system.exact,
                        tool_definition_tokens: tool_tokens,
                        skill_tokens,
                        conversation_tokens: row_tokens(0),
                        tool_result_tokens: row_tokens(1),
                        image_tokens,
                    };
                    assert_eq!(
                        context_breakdown(&messages, tools, skills, system),
                        breakdown
                    );
                    let heuristic = wire_bytes(&messages).div_ceil(3)
                        + wire_bytes(tools).div_ceil(3)
                        + skill_tokens
                        + messages.len() as u64 * 10
                        + image_tokens
                        + system.tokens;
                    for anchor_len in [
                        None,
                        Some(0),
                        Some(messages.len() / 2),
                        Some(messages.len()),
                        Some(messages.len() + 1),
                    ] {
                        let anchor = anchor_len.map(|anchor_len| UsageAnchor {
                            prompt_tokens: 900,
                            completion_tokens: 40,
                            anchor_len,
                        });
                        let (prompt_tokens, anchored) = match anchor {
                            Some(anchor) if anchor.anchor_len <= messages.len() => {
                                let tail = &messages[anchor.anchor_len..];
                                let tail_tokens = if tail.is_empty() {
                                    0
                                } else {
                                    wire_bytes(&tail).div_ceil(3)
                                        + tail.len() as u64 * 10
                                        + view[anchor.anchor_len..]
                                            .iter()
                                            .map(|(_, count)| count)
                                            .sum::<u64>()
                                            * 1_600
                                };
                                (940 + tail_tokens, true)
                            }
                            _ => (heuristic, false),
                        };
                        let actual = estimate_context_usage(ContextEstimateInput {
                            messages: &messages,
                            tools,
                            skills,
                            context_length: 64_000,
                            max_response_tokens: 8_192,
                            protected_prompt_reserve_tokens: 2_048,
                            system_prompt: measured_system,
                            anchor,
                        });
                        assert_eq!(
                            actual,
                            ContextUsageEstimate {
                                context_length: 64_000,
                                heuristic_prompt_tokens: heuristic,
                                calibrated_prompt_tokens: prompt_tokens,
                                reserve_tokens: adaptive_output_reserve(
                                    64_000,
                                    8_192,
                                    prompt_tokens
                                ),
                                protected_tokens: system.tokens,
                                anchored,
                                breakdown,
                            },
                            "messages={messages:?} tools={tools:?} skills={skills:?} anchor={anchor:?}"
                        );
                    }
                }
            }
        }
    }
}
