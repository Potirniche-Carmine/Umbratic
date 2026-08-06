use std::sync::{Arc, atomic::Ordering};

use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    compaction::*,
    config::provider_endpoint_url,
    context::{
        ContextCalibration, ContextUsageEstimate, adaptive_output_reserve, estimate_context_usage,
        request_profile_fingerprint,
    },
    conversation_state::{ConversationStateSnapshotInput, snapshot_conversation_state},
    events::{empty_summary, increment, now_iso, step_settled_event},
    orient::orient_once,
    permission::PermissionBroker,
    public_progress::PublicProgressSchedule,
    repeat_guard::RepeatGuard,
    response_output::{emit_fallback_answer, looks_like_unstructured_tool_call, record_answer},
    session::{EventSink, InputPart, Session},
    skill_preflight::{
        collect_selected_skill_ids, harness_skill_context_message, run_harness_skill_preflight,
    },
    tool_scheduling::execute_calls,
    tools::{ToolCall, ToolResult, tool_surface, validate_tool_call_batch},
    turn_snapshot::TurnSnapshot,
    veil_client::{VeilChatResult, VeilRequestOptions, stream_veil_chat},
};

const MAX_TOOL_TURNS: usize = 64;
/// A tool that executed and failed is a normal working signal, so the model gets
/// room to try something else.
const MAX_FAILED_TOOL_TURNS: usize = 10;

/// A call that never reached an executor because it violated the generated
/// contract is different: it gets one concise typed error and at most two
/// consecutive repair attempts.
const MAX_INVALID_CALL_REPAIRS: usize = 2;
const MAX_PROVIDER_MESSAGES: usize = 512;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum RunOutcome {
    Completed,
    Aborted,
    ModelGaveUp,
    SafetyLimit,
}

fn set_run_outcome(summary: &mut Value, outcome: RunOutcome) {
    summary["outcome"] = serde_json::to_value(outcome).unwrap_or_else(|_| json!("completed"));
}

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

/// A preamble is narration for the user, not conversation state. It already
/// streamed to the desktop, and the tool calls below it carry every fact the
/// next step needs. Persisting it would put the model's own prose back in its
/// context, where each step imitates and extends the longest preamble it can
/// see; that ratchet is what turns a one-line preamble into a mid-turn recap by
/// step five. Dropping it here is what makes the one-sentence rule stable
/// instead of advisory.
fn assistant_tool_message(calls: &[ToolCall]) -> Value {
    json!({
        "role": "assistant",
        "content": Value::Null,
        "tool_calls": calls.iter().map(|call| json!({
            "id": call.id,
            "type": "function",
            "function": { "name": call.name, "arguments": match &call.arguments { Value::String(value) => value.clone(), value => value.to_string() } }
        })).collect::<Vec<_>>()
    })
}

fn result_content(call: &ToolCall, result: &ToolResult) -> String {
    result.model_text(&call.name)
}

fn aborted_tool_result_content(tool_name: &str) -> String {
    result_content(
        &ToolCall {
            id: String::new(),
            name: tool_name.to_owned(),
            arguments: json!({}),
            index: 0,
        },
        &ToolResult {
            summary: "aborted".into(),
            location: None,
            content: String::new(),
            status: "aborted".into(),
            code: Some("aborted".into()),
            error_message: Some("Tool call was aborted.".into()),
            exit_code: Some(1),
            details: None,
            continuation: None,
        },
    )
}

pub(crate) fn tool_call_ids_from_message(message: &Value) -> Vec<(String, String)> {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|call| {
            let id = call.get("id").and_then(Value::as_str)?.to_owned();
            if id.is_empty() {
                return None;
            }
            let name = call
                .get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_owned();
            Some((id, name))
        })
        .collect()
}

fn missing_tool_results(messages: &[Value]) -> Vec<(String, String)> {
    let mut pending = Vec::<(String, String)>::new();
    for message in messages {
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                pending = tool_call_ids_from_message(message);
            }
            Some("tool") => {
                if let Some(id) = message.get("tool_call_id").and_then(Value::as_str) {
                    pending.retain(|(pending_id, _)| pending_id != id);
                }
            }
            Some("user") if !pending.is_empty() => break,
            _ => {}
        }
    }
    pending
}

async fn reconcile_aborted_run(
    session: &Session,
    sink: &EventSink,
    run_id: &str,
    step_index: &mut u32,
    summary: &mut Value,
) -> Value {
    set_run_outcome(summary, RunOutcome::Aborted);
    let mut messages = session.messages.lock().await;
    let missing = missing_tool_results(&messages);
    let mut reconciled_step = false;
    if !missing.is_empty() {
        for (id, name) in &missing {
            messages.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": aborted_tool_result_content(name),
            }));
        }
        reconciled_step = true;
    }
    drop(messages);
    if reconciled_step {
        publish_step_settled(session, sink, run_id, step_index, "interrupted").await;
    }
    summary.clone()
}

fn skill_profile(session: &Session) -> Vec<Value> {
    session
        .config
        .skills
        .iter()
        .map(|skill| {
            json!({
                "id":skill.id,
                "name":skill.name,
                "description":skill.description,
                "source":skill.source
            })
        })
        .collect()
}

pub(crate) fn request_estimate(
    session: &Session,
    messages: &[Value],
    tools: &[Value],
    calibration: Option<&ContextCalibration>,
) -> (ContextUsageEstimate, String) {
    let skills = skill_profile(session);
    let additional = if skills.is_empty() {
        vec![]
    } else {
        vec![Value::Array(skills.clone())]
    };
    let mut usage = estimate_context_usage(
        messages,
        tools,
        session.config.context_length,
        session.config.max_response_tokens,
        session.config.protected_prompt_reserve_tokens,
        &additional,
    );
    let route = provider_endpoint_url(&session.config.provider)
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|_| {
            session
                .config
                .provider
                .chat_endpoint_path
                .clone()
                .unwrap_or_default()
        });
    let profile_fingerprint = request_profile_fingerprint(
        &session.config.provider.model_id,
        &route,
        session.config.context_length,
        session.config.protected_prompt_reserve_tokens,
        tools,
        &skills,
    );
    if let Some(calibration) = calibration {
        usage.calibrated_prompt_tokens =
            calibration.apply(&profile_fingerprint, usage.heuristic_prompt_tokens);
        usage.reserve_tokens = adaptive_output_reserve(
            session.config.context_length,
            session.config.max_response_tokens,
            usage.calibrated_prompt_tokens,
        );
    }
    (usage, profile_fingerprint)
}

fn context_event(session: &Session, usage: ContextUsageEstimate) -> Value {
    let usage = usage.event();
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
    result: &VeilChatResult,
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
pub(crate) struct PreparedRequest {
    pub(crate) messages: Vec<Value>,
    pub(crate) max_output_tokens: u64,
    usage: ContextUsageEstimate,
    profile_fingerprint: String,
}

/// Captures the immutable inputs to one provider request.
fn turn_snapshot(
    session: &Session,
    surface: std::sync::Arc<crate::tools::ToolSurface>,
    prepared: &PreparedRequest,
    harness_bucket: Option<String>,
) -> TurnSnapshot {
    let route = provider_endpoint_url(&session.config.provider)
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|_| {
            session
                .config
                .provider
                .chat_endpoint_path
                .clone()
                .unwrap_or_default()
        });
    TurnSnapshot::new(
        session,
        surface,
        prepared.messages.clone(),
        prepared.max_output_tokens,
        &skill_profile(session),
        route,
        harness_bucket,
    )
}

pub(crate) async fn prepared_messages(
    session: &Session,
    tools: &[Value],
) -> Result<PreparedRequest, String> {
    let mut messages = session.messages.lock().await;
    loop {
        let calibration = session.context_calibration.lock().await.clone();
        let (usage, profile_fingerprint) =
            request_estimate(session, &messages, tools, calibration.as_ref());
        let hard_input_limit = session.config.context_length.saturating_sub(1_000);
        let semantic_trigger = hard_input_limit.saturating_mul(80) / 100;
        if usage.calibrated_prompt_tokens >= semantic_trigger
            && attempt_semantic_compaction(session, &mut messages, tools).await
        {
            continue;
        }
        let fits_tokens = usage.estimated_tokens() <= session.config.context_length;
        if fits_tokens && messages.len() <= MAX_PROVIDER_MESSAGES {
            return Ok(PreparedRequest {
                messages: messages.clone(),
                max_output_tokens: usage.reserve_tokens,
                usage,
                profile_fingerprint,
            });
        }
        if !compact_oldest_tool_exchange(&mut messages) {
            return Err(format!(
                "Context window is full: the request needs approximately {} tokens including the minimum 1000-token response allowance, but the model limit is {}.",
                usage.estimated_tokens(),
                session.config.context_length,
            ));
        }
    }
}

/// Walks a proposed cut back to the nearest structurally safe boundary.
///
/// A cut is safe only between complete turns. Cutting immediately after an
/// assistant tool-call message would summarize the call away while its results
/// stayed in the tail, leaving orphan tool messages — invariant 3. Cutting onto
/// a tool message would split a batch the same way.
async fn update_context_calibration(
    session: &Session,
    prepared: &PreparedRequest,
    result: &VeilChatResult,
) {
    let Some(observed_prompt_tokens) = result.prompt_tokens else {
        return;
    };
    let Some(calibration) = ContextCalibration::from_observation(
        prepared.profile_fingerprint.clone(),
        observed_prompt_tokens,
        prepared.usage.heuristic_prompt_tokens,
        session.config.context_length,
    ) else {
        return;
    };
    *session.context_calibration.lock().await = Some(calibration);
}
fn context_overflow(error: &str) -> bool {
    error.contains("context_overflow_preflight") || error.contains("context_overflow_upstream")
}

async fn final_without_tools(
    session: &Arc<Session>,
    sink: &EventSink,
    summary: &mut Value,
    fallback: &str,
    harness_bucket: Option<&str>,
) {
    let Ok(mut prepared) = prepared_messages(session, &[]).await else {
        emit_fallback_answer(session, sink, summary, fallback).await;
        return;
    };
    sink.emit(context_event(session, prepared.usage));
    let mut response = stream_veil_chat(
        session,
        sink,
        &prepared.messages,
        &[],
        VeilRequestOptions {
            max_output_tokens: prepared.max_output_tokens,
            include_tools: false,
            harness_bucket: harness_bucket.map(str::to_owned),
        },
    )
    .await;
    if response
        .as_ref()
        .is_err_and(|error| context_overflow(error))
    {
        let mut messages = session.messages.lock().await;
        if attempt_semantic_compaction(session, &mut messages, &[]).await {
            drop(messages);
            if let Ok(retry) = prepared_messages(session, &[]).await {
                prepared = retry;
                response = stream_veil_chat(
                    session,
                    sink,
                    &prepared.messages,
                    &[],
                    VeilRequestOptions {
                        max_output_tokens: prepared.max_output_tokens,
                        include_tools: false,
                        harness_bucket: harness_bucket.map(str::to_owned),
                    },
                )
                .await;
            }
        }
    }
    match response {
        Ok(result)
            if !result.content.trim().is_empty()
                && !looks_like_unstructured_tool_call(&result.content) =>
        {
            update_context_calibration(session, &prepared, &result).await;
            if let Some(event) =
                observed_context_event(session, &result, prepared.max_output_tokens)
            {
                sink.emit(event);
            }
            increment(summary, "turns", 1);
            record_answer(session, summary, &result.content).await;
        }
        _ => {
            emit_fallback_answer(session, sink, summary, fallback).await;
        }
    }
}

async fn publish_step_settled(
    session: &Session,
    sink: &EventSink,
    run_id: &str,
    step_index: &mut u32,
    outcome: &str,
) {
    *step_index = step_index.saturating_add(1);
    let step_id = format!("step-{step_index}");
    let messages = session.messages.lock().await.clone();
    let summary = session.durable_summary.lock().await.clone();
    let calibration = session.context_calibration.lock().await.clone();
    let skills = session
        .config
        .skills
        .iter()
        .map(|skill| {
            json!({
                "id": skill.id,
                "name": skill.name,
                "description": skill.description,
                "source": skill.source,
            })
        })
        .collect::<Vec<_>>();
    let additional = if skills.is_empty() {
        vec![]
    } else {
        vec![Value::Array(skills)]
    };
    let mut state = snapshot_conversation_state(ConversationStateSnapshotInput {
        task_id: &session.task_id,
        updated_at: now_iso(),
        summary,
        messages: &messages,
        context_length: session.config.context_length,
        estimated_prompt_tokens: 0,
        calibration: calibration.as_ref(),
        compaction_count: session.compaction_count.load(Ordering::SeqCst),
    });
    let rebuilt = state.seeded_messages();
    let estimate = estimate_context_usage(
        &rebuilt,
        &[],
        session.config.context_length,
        session.config.max_response_tokens,
        session.config.protected_prompt_reserve_tokens,
        &additional,
    );
    state.usage.estimated_prompt_tokens = estimate.heuristic_prompt_tokens;
    let Ok(state) = state.validate() else {
        return;
    };
    let Ok(conversation_state) = serde_json::to_value(&state) else {
        return;
    };
    sink.emit(step_settled_event(
        &session.task_id,
        &session.id,
        run_id,
        &step_id,
        outcome,
        conversation_state,
    ));
}

pub async fn run_turn(
    session: Arc<Session>,
    run_id: String,
    parts: Vec<InputPart>,
    selected_skill_ids: Vec<String>,
    sink: EventSink,
    permissions: Arc<PermissionBroker>,
) -> Result<Value, String> {
    // Abort is owned by the active RunGuard created by /prompt_async. Starting a run
    // must not clear another run's abort flag.
    let explicit_text = parts
        .iter()
        .filter_map(|part| match part {
            InputPart::Text { text } => Some(text.as_str()),
            InputPart::Image { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Editors change files between turns. Marking the path generation stale here
    // makes the first search of this run rebuild, while later searches in the
    // same run stay warm. A run that never searches never pays for the walk.
    session.search_index.mark_stale();

    // Work 3: guaranteed skill loading — harness preflight before any model request.
    let selected_ids = collect_selected_skill_ids(&session, &explicit_text, &selected_skill_ids);
    let loaded_skills = run_harness_skill_preflight(&session, &run_id, &selected_ids, &sink)?;

    let mut messages = session.messages.lock().await;
    for skill in &loaded_skills {
        messages.push(harness_skill_context_message(skill));
    }
    messages.push(json!({ "role": "user", "content": message_content(parts) }));
    drop(messages);

    // Orient runs exactly once per accepted run, after the current user message
    // is appended and before the tool loop. Every step of this run reuses the
    // decision, including compaction and context-overflow retries.
    let harness_bucket = orient_once(&session, &sink, &explicit_text).await;

    let mut summary = empty_summary();
    set_run_outcome(&mut summary, RunOutcome::Completed);
    let mut consecutive_failed = 0usize;
    let mut consecutive_invalid = 0usize;
    let mut repeat_guard = RepeatGuard::default();
    let mut public_progress = PublicProgressSchedule::default();
    let mut step_index = 0_u32;
    for _ in 0..MAX_TOOL_TURNS {
        if session.is_aborted() {
            return Ok(reconcile_aborted_run(
                &session,
                &sink,
                &run_id,
                &mut step_index,
                &mut summary,
            )
            .await);
        }
        // Everything this request depends on is captured once, before it goes
        // out. A deferred change landing mid-request cannot reach the in-flight
        // turn, because the turn no longer reads session state.
        let surface = tool_surface(&session);
        let tools = surface.specs().to_vec();
        let mut prepared = prepared_messages(&session, &tools).await?;
        let mut snapshot = Arc::new(turn_snapshot(
            &session,
            surface.clone(),
            &prepared,
            harness_bucket.clone(),
        ));
        sink.emit(context_event(&session, prepared.usage));
        let mut response = stream_veil_chat(
            &session,
            &sink,
            snapshot.messages(),
            snapshot.tools(),
            VeilRequestOptions {
                max_output_tokens: snapshot.max_output_tokens(),
                include_tools: true,
                harness_bucket: snapshot.harness_bucket().map(str::to_owned),
            },
        )
        .await;
        if response
            .as_ref()
            .is_err_and(|error| context_overflow(error))
        {
            public_progress.before_context_recovery(&session, &sink, &mut summary);
            let mut messages = session.messages.lock().await;
            if attempt_semantic_compaction(&session, &mut messages, &tools).await {
                drop(messages);
                prepared = prepared_messages(&session, &tools).await?;
                // Compaction replaced the conversation state, so the turn is
                // re-snapshotted rather than reusing stale prompt assembly.
                snapshot = Arc::new(turn_snapshot(
                    &session,
                    surface.clone(),
                    &prepared,
                    harness_bucket.clone(),
                ));
                sink.emit(context_event(&session, prepared.usage));
                response = stream_veil_chat(
                    &session,
                    &sink,
                    snapshot.messages(),
                    snapshot.tools(),
                    VeilRequestOptions {
                        max_output_tokens: snapshot.max_output_tokens(),
                        include_tools: true,
                        harness_bucket: snapshot.harness_bucket().map(str::to_owned),
                    },
                )
                .await;
            }
        }
        let result = match response {
            Ok(result) => result,
            Err(error) if error.to_ascii_lowercase().contains("aborted") => {
                return Ok(reconcile_aborted_run(
                    &session,
                    &sink,
                    &run_id,
                    &mut step_index,
                    &mut summary,
                )
                .await);
            }
            Err(error) => return Err(error),
        };
        update_context_calibration(&session, &prepared, &result).await;
        increment(&mut summary, "turns", 1);
        if let Some(event) = observed_context_event(&session, &result, snapshot.max_output_tokens())
        {
            sink.emit(event);
        }
        let calls = result.tool_calls.clone();
        increment(&mut summary, "toolCalls", calls.len() as u64);
        if calls.is_empty() {
            if looks_like_unstructured_tool_call(&result.content) {
                let call = ToolCall {
                    id: format!("protocol-error-{}", summary["turns"].as_u64().unwrap_or(0)),
                    name: "invalid_tool_syntax".into(),
                    arguments: json!({}),
                    index: 0,
                };
                let error = "Assistant text contained raw tool syntax. Use one available structured tool with its declared JSON schema.";
                let mut messages = session.messages.lock().await;
                messages.push(assistant_tool_message(std::slice::from_ref(&call)));
                messages.push(json!({"role":"tool","tool_call_id":call.id,"content":error}));
                drop(messages);
                publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
                continue;
            }
            if !result.content.trim().is_empty() {
                increment(
                    &mut summary,
                    "assistantTextChars",
                    result.content.len() as u64,
                );
                session
                    .messages
                    .lock()
                    .await
                    .push(json!({"role":"assistant","content":result.content}));
                publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
                return Ok(summary);
            }
            final_without_tools(
                &session,
                &sink,
                &mut summary,
                "The model did not provide a final answer.",
                harness_bucket.as_deref(),
            )
            .await;
            set_run_outcome(&mut summary, RunOutcome::ModelGaveUp);
            publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
            return Ok(summary);
        }
        if let Err(violation) = validate_tool_call_batch(&session, &calls) {
            let error = violation.message();
            consecutive_invalid += 1;
            let mut messages = session.messages.lock().await;
            messages.push(assistant_tool_message(&calls));
            for call in &calls {
                messages.push(json!({"role":"tool","tool_call_id":call.id,"content":error}));
            }
            drop(messages);
            publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
            if consecutive_invalid >= MAX_INVALID_CALL_REPAIRS {
                final_without_tools(&session, &sink, &mut summary, "I stopped after repeated invalid workspace tool calls. Review the latest tool error before trying a different approach.", harness_bucket.as_deref()).await;
                set_run_outcome(&mut summary, RunOutcome::ModelGaveUp);
                publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
                return Ok(summary);
            }
            continue;
        }
        session
            .messages
            .lock()
            .await
            .push(assistant_tool_message(&calls));
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
            } else {
                increment(&mut summary, "failedToolCalls", 1);
                summary["lastToolFailure"] = json!({"toolKind":call.name,"status":result.status,"errorCode":result.code,"message":result.error_message.clone().unwrap_or_else(|| result.content.clone())});
            }
        }
        let mut messages = session.messages.lock().await;
        for (call, result) in calls.iter().zip(&results) {
            messages.push(
                json!({"role":"tool","tool_call_id":call.id,"content":result_content(call,result)}),
            );
        }
        drop(messages);
        let step_outcome = if session.is_aborted() {
            "interrupted"
        } else {
            "completed"
        };
        publish_step_settled(&session, &sink, &run_id, &mut step_index, step_outcome).await;
        if session.is_aborted() {
            set_run_outcome(&mut summary, RunOutcome::Aborted);
            return Ok(summary);
        }
        consecutive_invalid = 0;
        if any_success {
            consecutive_failed = 0
        } else {
            consecutive_failed += 1
        }
        if consecutive_failed >= MAX_FAILED_TOOL_TURNS {
            final_without_tools(&session, &sink, &mut summary, "I stopped after repeated workspace tool failures. Review the latest tool output before trying a different approach.", harness_bucket.as_deref()).await;
            set_run_outcome(&mut summary, RunOutcome::SafetyLimit);
            publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
            return Ok(summary);
        }
        if repeat_guard.should_stop(&calls, &results) {
            final_without_tools(
                &session,
                &sink,
                &mut summary,
                "I stopped because the same workspace tool call returned the same result repeatedly.",
                harness_bucket.as_deref(),
            )
            .await;
            set_run_outcome(&mut summary, RunOutcome::SafetyLimit);
            publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
            return Ok(summary);
        }
    }
    final_without_tools(
        &session,
        &sink,
        &mut summary,
        "I reached the workspace tool safety limit before finishing.",
        harness_bucket.as_deref(),
    )
    .await;
    set_run_outcome(&mut summary, RunOutcome::SafetyLimit);
    publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
    Ok(summary)
}

#[cfg(test)]
#[path = "loop_runtime_tests.rs"]
mod tests;
