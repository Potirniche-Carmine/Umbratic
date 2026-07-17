use std::sync::Arc;

use futures_util::future::join_all;
use serde_json::{Value, json};

use crate::{
    config::provider_endpoint_url,
    context::estimate_context_usage,
    events::now_iso,
    permission::PermissionBroker,
    provider::{ProviderResult, stream_provider_chat},
    session::{EventSink, InputPart, Session},
    tools::{ToolCall, ToolResult, canonical_tool_name, enabled_tool_specs, execute_tool},
};

const MAX_TOOL_TURNS: usize = 64;
const MAX_FAILED_TURNS: usize = 3;
const MAX_REPEATED_TURNS: usize = 3;
const MAX_RETAINED_TOOL_EXCHANGES: usize = 12;
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
            && !matches!(
                path.as_str(),
                "/api/engineering/chat" | "/api/marketing/chat" | "/api/sales/chat"
            )
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
    let content = format!("{TOOL_HISTORY_SUMMARY_PREFIX}{summary}");
    messages.insert(
        index.min(messages.len()),
        json!({"role":"user","content":content}),
    );
}

fn compact_tool_history(messages: &mut Vec<Value>) {
    loop {
        let structured = messages
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
            .collect::<Vec<_>>();
        if structured.len() <= MAX_RETAINED_TOOL_EXCHANGES {
            break;
        }
        let start = structured[0];
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
    }

    loop {
        let prose = messages
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
            .collect::<Vec<_>>();
        if prose.len() <= MAX_RETAINED_TOOL_EXCHANGES {
            break;
        }
        let tool_index = prose[0];
        let start = tool_index.saturating_sub(1);
        let summary = messages[tool_index]
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        messages.drain(start..=tool_index);
        append_compacted_summary(messages, start, &summary);
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
    json!({ "type": "context.usage", "taskId": session.task_id, "contextLength": usage["contextLength"], "contentTokens": usage["contentTokens"], "reserveTokens": usage["reserveTokens"], "estimatedTokens": usage["estimatedTokens"], "at": now_iso() })
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
    let messages = session.messages.lock().await.clone();
    sink.emit(context_event(session, &messages, &[]));
    match stream_provider_chat(session, sink, &messages, &[], false, false, false).await {
        Ok(result) if !result.content.trim().is_empty() => {
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
        let messages = session.messages.lock().await.clone();
        sink.emit(context_event(&session, &messages, &tools));
        let result = stream_provider_chat(
            &session,
            &sink,
            &messages,
            &tools,
            true,
            !action_requirement.is_empty() && action_retries > 0 && !ready_for_answer,
            !action_requirement.is_empty() && !ready_for_answer,
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
        if let Some(tokens) = result.prompt_tokens {
            let reserve = session
                .config
                .max_response_tokens
                .min(session.config.context_length / 4)
                + session
                    .config
                    .protected_prompt_reserve_tokens
                    .min(session.config.context_length / 4);
            sink.emit(json!({"type":"context.usage","taskId":session.task_id,"contextLength":session.config.context_length,"contentTokens":tokens + result.completion_tokens.unwrap_or(0),"reserveTokens":reserve,"estimatedTokens":tokens + result.completion_tokens.unwrap_or(0) + reserve,"at":now_iso()}));
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
}
