use std::sync::Arc;

use futures_util::future::join_all;
use serde_json::{Value, json};

use crate::{
    config::provider_endpoint_url,
    context::estimate_context_usage,
    events::now_iso,
    permission::PermissionBroker,
    provider::{ProviderRequestOptions, ProviderResult, stream_provider_chat},
    session::{EventSink, InputPart, Session},
    tools::{ToolCall, ToolResult, canonical_tool_name, enabled_tool_specs, execute_tool},
};

const MAX_TOOL_TURNS: usize = 64;
const MAX_FAILED_TURNS: usize = 3;
const MAX_REPEATED_TURNS: usize = 3;
const MAX_RETAINED_TOOL_EXCHANGES: usize = 12;
const MAX_PROVIDER_MESSAGES: usize = 60;
const MAX_TOOL_HISTORY_SUMMARY_CHARS: usize = 8_000;
const TOOL_HISTORY_SUMMARY_PREFIX: &str =
    "Earlier workspace tool results (compacted factual context):\n";

fn message_content(parts: Vec<InputPart>) -> Value {
    if parts.len() == 1
        && let InputPart::Text { text } = &parts[0]
    {
        return Value::String(text.clone());
    }
    Value::Array(
        parts
            .into_iter()
            .map(|part| match part {
                InputPart::Text { text } => json!({ "type": "text", "text": text }),
                InputPart::Image { data_url } => {
                    json!({ "type": "image_url", "image_url": { "url": data_url } })
                }
            })
            .collect(),
    )
}

fn structured_tool_history(session: &Session) -> bool {
    provider_endpoint_url(&session.config.provider).is_ok_and(|url| {
        let path = url.path().trim_end_matches('/').to_ascii_lowercase();
        !path.ends_with("/api/chat")
    })
}

fn assistant_tool_message(result: &ProviderResult, calls: &[ToolCall]) -> Value {
    json!({
        "role": "assistant",
        "content": if result.content.is_empty() { Value::Null } else { Value::String(result.content.clone()) },
        "tool_calls": calls.iter().map(|call| json!({
            "id": call.id,
            "type": "function",
            "function": { "name": call.name, "arguments": match &call.arguments { Value::String(value) => value.clone(), value => value.to_string() } }
        })).collect::<Vec<_>>()
    })
}

fn result_content(call: &ToolCall, result: &ToolResult) -> String {
    format!(
        "{}: {} ({})\n{}",
        canonical_tool_name(&call.name),
        result.title,
        if result.status == "success" {
            "ok"
        } else {
            &result.status
        },
        result.output
    )
}

fn prose_tool_context(calls: &[ToolCall], results: &[ToolResult]) -> String {
    let rows = calls
        .iter()
        .zip(results)
        .map(|(call, result)| result_content(call, result))
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("Workspace tool results (factual local context):\n\n{rows}")
}

fn append_compacted_summary(messages: &mut Vec<Value>, index: usize, summary: &str) {
    if let Some(existing) = messages.iter_mut().find(|message| {
        message.get("role").and_then(Value::as_str) == Some("user")
            && message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| content.starts_with(TOOL_HISTORY_SUMMARY_PREFIX))
    }) {
        let content = existing["content"].as_str().unwrap_or_default();
        let combined = format!("{content}\n\n{summary}");
        let body = combined
            .strip_prefix(TOOL_HISTORY_SUMMARY_PREFIX)
            .unwrap_or(&combined)
            .chars()
            .rev()
            .take(MAX_TOOL_HISTORY_SUMMARY_CHARS - TOOL_HISTORY_SUMMARY_PREFIX.len())
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        existing["content"] = Value::String(format!("{TOOL_HISTORY_SUMMARY_PREFIX}{body}"));
        return;
    }
    let body_limit = MAX_TOOL_HISTORY_SUMMARY_CHARS - TOOL_HISTORY_SUMMARY_PREFIX.len();
    let body = summary
        .chars()
        .rev()
        .take(body_limit)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let content = format!("{TOOL_HISTORY_SUMMARY_PREFIX}{body}");
    messages.insert(
        index.min(messages.len()),
        json!({"role":"user","content":content}),
    );
}

fn structured_tool_exchanges(messages: &[Value]) -> Vec<usize> {
    messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            message.get("role").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_some()
        })
        .map(|(index, _)| index)
        .collect()
}

fn prose_tool_exchanges(messages: &[Value]) -> Vec<usize> {
    messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            message.get("role").and_then(Value::as_str) == Some("user")
                && message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| content.starts_with("Workspace tool results"))
        })
        .map(|(index, _)| index)
        .collect()
}

fn compact_oldest_tool_exchange(messages: &mut Vec<Value>) -> bool {
    if let Some(start) = structured_tool_exchanges(messages).first().copied() {
        let mut end = start + 1;
        while end < messages.len()
            && messages[end].get("role").and_then(Value::as_str) == Some("tool")
        {
            end += 1;
        }
        let summary = messages[start + 1..end]
            .iter()
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        messages.drain(start..end);
        append_compacted_summary(messages, start, &summary);
        return true;
    }
    if let Some(tool_index) = prose_tool_exchanges(messages).first().copied() {
        let summary = messages[tool_index]
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        messages.remove(tool_index);
        append_compacted_summary(messages, tool_index, &summary);
        return true;
    }
    false
}

fn compact_tool_history(messages: &mut Vec<Value>) {
    while structured_tool_exchanges(messages).len() > MAX_RETAINED_TOOL_EXCHANGES
        || prose_tool_exchanges(messages).len() > MAX_RETAINED_TOOL_EXCHANGES
    {
        if !compact_oldest_tool_exchange(messages) {
            break;
        }
    }
}

async fn execute_calls(
    session: Arc<Session>,
    sink: EventSink,
    permissions: Arc<PermissionBroker>,
    calls: Vec<ToolCall>,
) -> Vec<ToolResult> {
    let exclusive = |name: &str| {
        matches!(
            canonical_tool_name(name).as_str(),
            "write" | "edit" | "command"
        )
    };
    let mut results: Vec<Option<ToolResult>> = vec![None; calls.len()];
    let mut parallel = Vec::new();
    async fn flush_parallel(
        session: &Arc<Session>,
        sink: &EventSink,
        permissions: &Arc<PermissionBroker>,
        calls: &[ToolCall],
        pending: &mut Vec<usize>,
        results: &mut [Option<ToolResult>],
    ) {
        if pending.is_empty() {
            return;
        }
        let indices = std::mem::take(pending);
        let futures = indices.iter().map(|index| {
            execute_tool(
                session.clone(),
                sink.clone(),
                permissions.clone(),
                calls[*index].clone(),
            )
        });
        let completed = join_all(futures).await;
        for (index, result) in indices.into_iter().zip(completed) {
            results[index] = Some(result);
        }
    }
    for (index, call) in calls.iter().enumerate() {
        if exclusive(&call.name) {
            flush_parallel(
                &session,
                &sink,
                &permissions,
                &calls,
                &mut parallel,
                &mut results,
            )
            .await;
            results[index] = Some(
                execute_tool(
                    session.clone(),
                    sink.clone(),
                    permissions.clone(),
                    call.clone(),
                )
                .await,
            );
        } else {
            parallel.push(index);
        }
    }
    flush_parallel(
        &session,
        &sink,
        &permissions,
        &calls,
        &mut parallel,
        &mut results,
    )
    .await;
    results.into_iter().map(Option::unwrap).collect()
}

fn context_event(session: &Session, messages: &[Value], tools: &[Value]) -> Value {
    let additional = if session.config.skills.is_empty() {
        vec![]
    } else {
        vec![Value::Array(session.config.skills.iter().map(|skill| json!({ "id":skill.id,"name":skill.name,"description":skill.description,"source":skill.source })).collect())]
    };
    let usage = estimate_context_usage(
        messages,
        tools,
        session.config.context_length,
        session.config.max_response_tokens,
        session.config.protected_prompt_reserve_tokens,
        &additional,
    );
    json!({ "type": "context.usage", "taskId": session.task_id, "contextLength": usage["contextLength"], "contentTokens": usage["contentTokens"], "promptTokens": usage["promptTokens"], "completionTokens": usage["completionTokens"], "reserveTokens": usage["reserveTokens"], "protectedTokens": usage["protectedTokens"], "estimatedTokens": usage["estimatedTokens"], "phase": usage["phase"], "source": usage["source"], "confidence": usage["confidence"], "at": now_iso() })
}

fn observed_context_usage(
    context_length: u64,
    reserve_tokens: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> Value {
    json!({
        "contextLength": context_length,
        "contentTokens": prompt_tokens,
        "promptTokens": prompt_tokens,
        "completionTokens": completion_tokens,
        "reserveTokens": reserve_tokens,
        "protectedTokens": 0,
        "estimatedTokens": prompt_tokens + reserve_tokens,
        "phase": "observed",
        "source": "provider",
        "confidence": "high"
    })
}

fn observed_context_event(
    session: &Session,
    result: &ProviderResult,
    reserve_tokens: u64,
) -> Option<Value> {
    let usage = observed_context_usage(
        session.config.context_length,
        reserve_tokens,
        result.prompt_tokens?,
        result.completion_tokens.unwrap_or(0),
    );
    Some(
        json!({ "type": "context.usage", "taskId": session.task_id, "contextLength": usage["contextLength"], "contentTokens": usage["contentTokens"], "promptTokens": usage["promptTokens"], "completionTokens": usage["completionTokens"], "reserveTokens": usage["reserveTokens"], "protectedTokens": usage["protectedTokens"], "estimatedTokens": usage["estimatedTokens"], "phase": usage["phase"], "source": usage["source"], "confidence": usage["confidence"], "at": now_iso() }),
    )
}

#[derive(Debug)]
struct PreparedRequest {
    messages: Vec<Value>,
    max_output_tokens: u64,
}

async fn prepared_messages(session: &Session, tools: &[Value]) -> Result<PreparedRequest, String> {
    let mut messages = session.messages.lock().await;
    compact_tool_history(&mut messages);
    loop {
        let event = context_event(session, &messages, tools);
        let fits_tokens =
            event["estimatedTokens"].as_u64().unwrap_or(u64::MAX) <= session.config.context_length;
        if fits_tokens && messages.len() <= MAX_PROVIDER_MESSAGES {
            return Ok(PreparedRequest {
                messages: messages.clone(),
                max_output_tokens: event["reserveTokens"].as_u64().unwrap_or(1_000),
            });
        }
        if !compact_oldest_tool_exchange(&mut messages) {
            return Err(format!(
                "Context window is full: the request needs approximately {} tokens including the minimum 1000-token response allowance, but the model limit is {}.",
                event["estimatedTokens"].as_u64().unwrap_or(0),
                session.config.context_length,
            ));
        }
    }
}

fn empty_summary() -> Value {
    json!({ "status":"completed", "turns":0, "assistantTextChars":0, "reasoningTextChars":0, "toolCalls":0, "failedToolCalls":0, "attempts":[] })
}

fn increment(summary: &mut Value, key: &str, amount: u64) {
    let current = summary.get(key).and_then(Value::as_u64).unwrap_or(0);
    summary[key] = Value::from(current + amount);
}

fn evidence_satisfied(action: &str, changed: bool, executed: bool, inspected: bool) -> bool {
    match action {
        "change" => changed,
        "execute" => executed,
        "inspect" => inspected,
        "change-and-execute" => changed && executed,
        _ => true,
    }
}

async fn final_without_tools(
    session: &Arc<Session>,
    sink: &EventSink,
    summary: &mut Value,
    fallback: &str,
) {
    let Ok(prepared) = prepared_messages(session, &[]).await else {
        sink.emit(
            json!({"type":"assistant.answer.started","taskId":session.task_id,"at":now_iso()}),
        );
        sink.emit(json!({"type":"assistant.delta","taskId":session.task_id,"text":fallback,"at":now_iso()}));
        increment(summary, "assistantTextChars", fallback.len() as u64);
        return;
    };
    sink.emit(context_event(session, &prepared.messages, &[]));
    match stream_provider_chat(
        session,
        sink,
        &prepared.messages,
        &[],
        ProviderRequestOptions {
            max_output_tokens: prepared.max_output_tokens,
            include_tools: false,
            require_tool_call: false,
            suppress_output: false,
        },
    )
    .await
    {
        Ok(result) if !result.content.trim().is_empty() => {
            if let Some(event) =
                observed_context_event(session, &result, prepared.max_output_tokens)
            {
                sink.emit(event);
            }
            increment(summary, "turns", 1);
            increment(summary, "assistantTextChars", result.content.len() as u64);
            increment(summary, "reasoningTextChars", result.reasoning.len() as u64);
            session
                .messages
                .lock()
                .await
                .push(json!({"role":"assistant","content":result.content}));
        }
        _ => {
            sink.emit(
                json!({"type":"assistant.answer.started","taskId":session.task_id,"at":now_iso()}),
            );
            sink.emit(json!({"type":"assistant.delta","taskId":session.task_id,"text":fallback,"at":now_iso()}));
            increment(summary, "assistantTextChars", fallback.len() as u64);
            session
                .messages
                .lock()
                .await
                .push(json!({"role":"assistant","content":fallback}));
        }
    }
}

pub async fn run_turn(
    session: Arc<Session>,
    parts: Vec<InputPart>,
    sink: EventSink,
    permissions: Arc<PermissionBroker>,
) -> Result<Value, String> {
    session.reset_abort();
    session
        .messages
        .lock()
        .await
        .push(json!({ "role": "user", "content": message_content(parts) }));
    let mut summary = empty_summary();
    let mut consecutive_failed = 0usize;
    let mut previous_signature = String::new();
    let mut repeated = 0usize;
    let mut action_requirement = String::new();
    let mut action_retries = 0usize;
    let mut changed = false;
    let mut executed = false;
    let mut inspected = false;
    let mut final_prompted = false;
    for _ in 0..MAX_TOOL_TURNS {
        if session.is_aborted() {
            return Err("Runner turn aborted".into());
        }
        let ready_for_answer = !action_requirement.is_empty()
            && evidence_satisfied(&action_requirement, changed, executed, inspected);
        if ready_for_answer && !final_prompted {
            final_prompted = true;
            session.messages.lock().await.push(json!({"role":"user","content":"The required workspace evidence is now available. Provide the complete final answer to the original request. Do not announce additional work unless you make the structured tool call in this turn."}));
        }
        let tools = enabled_tool_specs(&session, true).await;
        let prepared = prepared_messages(&session, &tools).await?;
        sink.emit(context_event(&session, &prepared.messages, &tools));
        let result = stream_provider_chat(
            &session,
            &sink,
            &prepared.messages,
            &tools,
            ProviderRequestOptions {
                max_output_tokens: prepared.max_output_tokens,
                include_tools: true,
                require_tool_call: !action_requirement.is_empty()
                    && action_retries > 0
                    && !ready_for_answer,
                suppress_output: !action_requirement.is_empty() && !ready_for_answer,
            },
        )
        .await?;
        increment(&mut summary, "turns", 1);
        increment(
            &mut summary,
            "assistantTextChars",
            result.content.len() as u64,
        );
        increment(
            &mut summary,
            "reasoningTextChars",
            result.reasoning.len() as u64,
        );
        if let Some(event) = observed_context_event(&session, &result, prepared.max_output_tokens) {
            sink.emit(event);
        }
        if action_requirement.is_empty() {
            action_requirement = result.action_requirement.clone();
        }
        let calls = result.tool_calls.clone();
        increment(&mut summary, "toolCalls", calls.len() as u64);
        if calls.is_empty() {
            if !action_requirement.is_empty()
                && !evidence_satisfied(&action_requirement, changed, executed, inspected)
            {
                if action_retries < 2 {
                    action_retries += 1;
                    session.messages.lock().await.push(json!({"role":"user","content":"The requested workspace action is not complete. Use the available structured workspace tools now. Do not answer with code fences or simulated command output."}));
                    continue;
                }
                let fallback = "I couldn't complete the requested workspace action because the model did not use the required structured tool call. I won't claim that the remaining work succeeded.";
                sink.emit(json!({"type":"assistant.answer.started","taskId":session.task_id,"at":now_iso()}));
                sink.emit(json!({"type":"assistant.delta","taskId":session.task_id,"text":fallback,"at":now_iso()}));
                increment(&mut summary, "assistantTextChars", fallback.len() as u64);
                session
                    .messages
                    .lock()
                    .await
                    .push(json!({"role":"assistant","content":fallback}));
                return Ok(summary);
            }
            session
                .messages
                .lock()
                .await
                .push(json!({"role":"assistant","content":result.content}));
            let replayed = session.messages.lock().await.clone();
            sink.emit(context_event(&session, &replayed, &tools));
            return Ok(summary);
        }
        let signature = calls
            .iter()
            .map(|call| format!("{}\0{}", call.name, call.arguments))
            .collect::<Vec<_>>()
            .join("\u{1}");
        if signature == previous_signature {
            repeated += 1;
        } else {
            previous_signature = signature;
            repeated = 1;
        }
        let structured = structured_tool_history(&session);
        if structured {
            session
                .messages
                .lock()
                .await
                .push(assistant_tool_message(&result, &calls));
        } else if !result.content.trim().is_empty() {
            session
                .messages
                .lock()
                .await
                .push(json!({"role":"assistant","content":result.content}));
        }
        let results = execute_calls(
            session.clone(),
            sink.clone(),
            permissions.clone(),
            calls.clone(),
        )
        .await;
        let mut any_success = false;
        for (call, result) in calls.iter().zip(&results) {
            if result.status == "success" {
                any_success = true;
                let name = canonical_tool_name(&call.name);
                changed |= matches!(name.as_str(), "write" | "edit");
                executed |= name == "command";
                inspected |= name == "read"
                    && result.title == "."
                    && result.output.contains("Listing status: complete");
            } else {
                increment(&mut summary, "failedToolCalls", 1);
                summary["lastToolFailure"] = json!({"toolKind":call.name,"status":result.status,"errorCode":result.error_code,"message":result.error_message.clone().unwrap_or_else(|| result.output.clone())});
            }
        }
        if structured {
            let mut messages = session.messages.lock().await;
            for (call, result) in calls.iter().zip(&results) {
                messages.push(json!({"role":"tool","tool_call_id":call.id,"content":result_content(call,result)}));
            }
        } else {
            session
                .messages
                .lock()
                .await
                .push(json!({"role":"user","content":prose_tool_context(&calls,&results)}));
        }
        let mut messages = session.messages.lock().await;
        compact_tool_history(&mut messages);
        drop(messages);
        if any_success {
            consecutive_failed = 0
        } else {
            consecutive_failed += 1
        }
        if consecutive_failed >= MAX_FAILED_TURNS {
            final_without_tools(&session, &sink, &mut summary, "I stopped after repeated workspace tool failures. Review the latest tool output before trying a different approach.").await;
            return Ok(summary);
        }
        if repeated >= MAX_REPEATED_TURNS {
            final_without_tools(
                &session,
                &sink,
                &mut summary,
                "I stopped after repeating the same workspace tool call without making progress.",
            )
            .await;
            return Ok(summary);
        }
    }
    final_without_tools(
        &session,
        &sink,
        &mut summary,
        "I reached the workspace tool safety limit before finishing.",
    )
    .await;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::AtomicBool};

    use crate::{context::SessionContextStore, session::test_config};
    #[test]
    fn prose_context_contains_real_tool_output() {
        let calls = vec![ToolCall {
            id: "c".into(),
            name: "read".into(),
            arguments: json!({}),
            index: 0,
        }];
        let results = vec![ToolResult {
            title: "README.md".into(),
            output: "1: hello".into(),
            status: "success".into(),
            error_code: None,
            error_message: None,
            exit_code: Some(0),
            details: None,
        }];
        assert!(prose_tool_context(&calls, &results).contains("read: README.md (ok)"));
    }

    #[test]
    fn old_structured_tool_exchanges_are_compacted_without_orphaning_results() {
        let mut messages = vec![json!({"role":"user","content":"original request"})];
        for index in 0..14 {
            messages.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":format!("call-{index}"),"type":"function","function":{"name":"read","arguments":"{}"}}]}));
            messages.push(json!({"role":"tool","tool_call_id":format!("call-{index}"),"content":format!("read result {index}")}));
        }
        compact_tool_history(&mut messages);
        assert_eq!(
            messages
                .iter()
                .filter(|message| message.get("tool_calls").is_some())
                .count(),
            MAX_RETAINED_TOOL_EXCHANGES
        );
        assert!(messages.iter().any(|message| {
            message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| {
                    content.starts_with(TOOL_HISTORY_SUMMARY_PREFIX)
                        && content.contains("read result 0")
                        && content.contains("read result 1")
                })
        }));
        for (index, message) in messages.iter().enumerate() {
            if message.get("role").and_then(Value::as_str) == Some("tool") {
                assert!(index > 0 && messages[index - 1].get("tool_calls").is_some());
            }
        }
    }

    #[test]
    fn parallel_tool_results_are_compacted_as_one_complete_exchange() {
        let mut messages = vec![json!({"role":"user","content":"original request"})];
        for index in 0..14 {
            messages.push(json!({"role":"assistant","content":null,"tool_calls":[
                {"id":format!("call-{index}-a"),"type":"function","function":{"name":"read","arguments":"{}"}},
                {"id":format!("call-{index}-b"),"type":"function","function":{"name":"search","arguments":"{}"}}
            ]}));
            messages.push(json!({"role":"tool","tool_call_id":format!("call-{index}-a"),"content":format!("read result {index}")}));
            messages.push(json!({"role":"tool","tool_call_id":format!("call-{index}-b"),"content":format!("search result {index}")}));
        }
        compact_tool_history(&mut messages);
        assert_eq!(structured_tool_exchanges(&messages).len(), 12);
        assert!(!messages.iter().any(|message| {
            matches!(
                message["tool_call_id"].as_str(),
                Some("call-0-a" | "call-0-b" | "call-1-a" | "call-1-b")
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
        assert!(summary.contains("read result 0") && summary.contains("search result 1"));
    }

    #[test]
    fn first_tool_history_summary_is_bounded() {
        let mut messages = vec![json!({"role":"user","content":"original request"})];
        append_compacted_summary(&mut messages, 1, &"x".repeat(20_000));
        let summary = messages[1]["content"].as_str().unwrap();
        assert!(summary.len() <= MAX_TOOL_HISTORY_SUMMARY_CHARS);
        assert!(summary.starts_with(TOOL_HISTORY_SUMMARY_PREFIX));
    }

    #[test]
    fn prose_compaction_never_removes_the_original_user_request() {
        let mut messages = vec![
            json!({"role":"user","content":"original request"}),
            json!({"role":"user","content":"Workspace tool results (factual local context):\nold result"}),
        ];
        assert!(compact_oldest_tool_exchange(&mut messages));
        assert!(
            messages
                .iter()
                .any(|message| message["content"] == "original request")
        );
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
            context_store: tokio::sync::Mutex::new(SessionContextStore::default()),
            workspace_graph: None,
            aborted: AtomicBool::new(false),
        };

        let prepared = prepared_messages(&session, &[]).await.unwrap();
        let usage = context_event(&session, &prepared.messages, &[]);
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
            context_store: tokio::sync::Mutex::new(SessionContextStore::default()),
            workspace_graph: None,
            aborted: AtomicBool::new(false),
        };

        let error = prepared_messages(&session, &[]).await.unwrap_err();
        assert!(error.contains("Context window is full"));
        assert!(error.contains("4000"));
    }
}
