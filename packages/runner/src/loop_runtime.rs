use std::sync::{Arc, atomic::Ordering};

use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    compaction::*,
    context::{
        ContextCalibration, ContextEstimateInput, ContextUsageEstimate, estimate_context_usage,
    },
    context_events::{
        clear_usage_anchor, compaction_blocked_reason, context_event, estimate_state,
        observed_context_event, record_system_prompt_size, request_estimate, set_usage_anchor,
        skill_profile,
    },
    conversation_state::{ConversationStateSnapshotInput, snapshot_conversation_state},
    events::{empty_summary, increment, now_iso, step_settled_event},
    orient::orient_once,
    permission::PermissionBroker,
    public_progress::{PublicProgressSchedule, compaction_finished, compaction_started},
    repeat_guard::RepeatGuard,
    response_output::{emit_fallback_answer, looks_like_unstructured_tool_call, record_answer},
    session::{EventSink, InputPart, Session},
    skill_preflight::{
        collect_selected_skill_ids, harness_skill_context_message, run_harness_skill_preflight,
    },
    tool_scheduling::execute_calls,
    tools::{ToolCall, ToolResult, tool_surface, validate_tool_call_batch},
    turn_snapshot::TurnSnapshot,
    veil_client::{
        HoldPolicy, VeilChatResult, VeilRequestOptions, release_held_text, stream_veil_chat,
    },
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

#[derive(Debug)]
pub(crate) struct PreparedRequest {
    pub(crate) messages: Vec<Value>,
    pub(crate) max_output_tokens: u64,
    usage: ContextUsageEstimate,
    profile_fingerprint: String,
}

/// Appends the assistant turn and re-anchors on it in one step, so the anchor
/// can never describe a message count the conversation does not have.
async fn append_assistant_turn(session: &Session, message: Value, result: &VeilChatResult) {
    let anchor_len = {
        let mut messages = session.messages.lock().await;
        messages.push(message);
        messages.len()
    };
    set_usage_anchor(session, result, anchor_len).await;
}

/// Renders the Hermes verdict on the previous compaction using the first
/// measurement taken after it. A compaction that succeeded but left the
/// context above the trigger earns a strike; two strikes mean the remaining
/// context is the incompressible system-prompt-and-tools floor.
async fn record_compaction_verdict(session: &Session, result: &VeilChatResult) {
    if !session
        .awaiting_observed_usage
        .swap(false, Ordering::SeqCst)
    {
        return;
    }
    let Some(prompt_tokens) = result.prompt_tokens else {
        return;
    };
    if prompt_tokens >= semantic_trigger_tokens(session.config.context_length) {
        session.compaction_strikes.fetch_add(1, Ordering::SeqCst);
    } else {
        session.compaction_strikes.store(0, Ordering::SeqCst);
    }
}

/// Captures the immutable inputs to one provider request.
fn turn_snapshot(
    surface: std::sync::Arc<crate::tools::ToolSurface>,
    prepared: &PreparedRequest,
    harness_bucket: Option<String>,
) -> TurnSnapshot {
    TurnSnapshot::new(
        surface,
        prepared.messages.clone(),
        prepared.max_output_tokens,
        harness_bucket,
    )
}

/// Whether a semantic compaction may be triggered by the current estimate.
///
/// Two guards, both about not acting on a number that is about to be replaced.
/// An unanchored estimate taken right after a compaction may not compact again
/// before the next response proves the real, smaller size; and a context that
/// two measured verdicts have shown cannot get below the trigger is at its
/// incompressible floor, where further summarization only burns tokens.
fn semantic_compaction_allowed(session: &Session, anchored: bool) -> bool {
    compaction_blocked_reason(session).is_none()
        && (anchored || !session.awaiting_observed_usage.load(Ordering::SeqCst))
}

pub(crate) async fn prepared_messages(
    session: &Session,
    tools: &[Value],
    sink: &EventSink,
) -> Result<PreparedRequest, String> {
    let mut messages = session.messages.lock().await;
    loop {
        let state = estimate_state(session).await;
        let (usage, profile_fingerprint) = request_estimate(session, &messages, tools, &state);
        if usage.calibrated_prompt_tokens >= semantic_trigger_tokens(session.config.context_length)
            && semantic_compaction_allowed(session, usage.anchored)
        {
            // The cheap deterministic tier first; summarization only if
            // folding stale exchanges could not get under the trigger. Only the
            // second tier is announced: the first is local and instant, while
            // the second blocks the turn on another model round-trip.
            if prune_stale_tool_results(session, &mut messages, tools, &state) {
                clear_usage_anchor(session).await;
                continue;
            }
            compaction_started(session, sink);
            let outcome = attempt_semantic_compaction(session, &mut messages, tools, &state).await;
            // Only a round-trip that came back unusable counts toward the
            // backoff. A refusal is the runner declining on its own terms and
            // costs nothing to reach again.
            match outcome {
                CompactionOutcome::Compacted => {
                    session.compaction_failures.store(0, Ordering::SeqCst);
                }
                CompactionOutcome::Failed => {
                    session.compaction_failures.fetch_add(1, Ordering::SeqCst);
                }
                CompactionOutcome::Refused => {}
            }
            compaction_finished(
                session,
                sink,
                outcome,
                usage.calibrated_prompt_tokens,
                request_estimate(session, &messages, tools, &state)
                    .0
                    .calibrated_prompt_tokens,
            );
            if outcome.compacted() {
                clear_usage_anchor(session).await;
                continue;
            }
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
        clear_usage_anchor(session).await;
    }
}

/// Recovery from a provider rejection, using the deterministic tiers only.
///
/// The provider has already refused this request, so recovery cannot depend on
/// another model round-trip succeeding — a summarization call would be one more
/// chance to fail at exactly the moment the session cannot afford one. And the
/// rejection has just proven every local estimate optimistic, so recovery does
/// not stop at "changed something": it keeps folding whole tool exchanges,
/// oldest first, until the heuristic estimate is back under the semantic
/// trigger or nothing foldable remains. A guided tour can fill the window with
/// tool results inside a single turn — where the semantic tiers cannot cut
/// because everything is in the protected tail — and the previous single-fold
/// recovery then lost its one retry and failed the whole run.
async fn recover_from_overflow(session: &Session, tools: &[Value]) -> bool {
    let state = estimate_state(session).await;
    let mut messages = session.messages.lock().await;
    let mut recovered = prune_stale_tool_results(session, &mut messages, tools, &state);
    let target = semantic_trigger_tokens(session.config.context_length);
    while request_estimate(session, &messages, tools, &state)
        .0
        .heuristic_prompt_tokens
        > target
        && compact_oldest_tool_exchange(&mut messages)
    {
        recovered = true;
    }
    drop(messages);
    if recovered {
        clear_usage_anchor(session).await;
    }
    recovered
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
    let Ok(mut prepared) = prepared_messages(session, &[], sink).await else {
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
            // final_without_tools is the last word of the run; there is no
            // later step that could refuse it, so nothing is held.
            hold: HoldPolicy::None,
        },
    )
    .await;
    if response
        .as_ref()
        .is_err_and(|error| context_overflow(error))
        && recover_from_overflow(session, &[]).await
        && let Ok(retry) = prepared_messages(session, &[], sink).await
    {
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
                // final_without_tools is the last word of the run; there is no
                // later step that could refuse it, so nothing is held.
                hold: HoldPolicy::None,
            },
        )
        .await;
    }
    match response {
        Ok(result)
            if !result.content.trim().is_empty()
                && !looks_like_unstructured_tool_call(&result.content) =>
        {
            update_context_calibration(session, &prepared, &result).await;
            record_system_prompt_size(session, &result).await;
            record_compaction_verdict(session, &result).await;
            if let Some(event) = observed_context_event(
                session,
                &result,
                prepared.max_output_tokens,
                prepared.usage.breakdown,
            ) {
                sink.emit(event);
            }
            increment(summary, "turns", 1);
            record_answer(session, summary, &result.content).await;
            let anchor_len = session.messages.lock().await.len();
            set_usage_anchor(session, &result, anchor_len).await;
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
    let skills = skill_profile(session);
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
    // The persisted size describes the rebuilt state on its own terms, so it is
    // deliberately unanchored: a measurement of the live conversation does not
    // describe the summary-plus-tail a restored session would start from.
    let estimate = estimate_context_usage(ContextEstimateInput {
        messages: &rebuilt,
        tools: &[],
        skills: &skills,
        context_length: session.config.context_length,
        max_response_tokens: session.config.max_response_tokens,
        protected_prompt_reserve_tokens: session.config.protected_prompt_reserve_tokens,
        system_prompt: *session.system_prompt_size.lock().await,
        anchor: None,
    });
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

/// Injects a pending steer into the running turn as the next user message.
///
/// The steer is appended to the same conversation the loop is already working
/// through, so nothing about the run resets: the orient decision, the run id,
/// and every tool result collected so far all survive.
async fn apply_pending_steer(session: &Arc<Session>, sink: &EventSink, run_id: &str) {
    let taken = {
        let mut queue = session.queue.lock().await;
        queue.take_steer(&session.task_id, &session.id, Some(run_id))
    };
    let Some((steer, update)) = taken else {
        return;
    };
    session
        .messages
        .lock()
        .await
        .push(json!({ "role": "user", "content": message_content(steer.parts) }));
    sink.emit(update.event);
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
    let orient = orient_once(&session, &sink, &explicit_text).await;
    let harness_bucket = orient.bucket.clone();

    let mut summary = empty_summary();
    set_run_outcome(&mut summary, RunOutcome::Completed);
    let mut consecutive_failed = 0usize;
    let mut consecutive_invalid = 0usize;
    // The evidence rule fires at most once per run. A model that answers from
    // nothing twice is answering deliberately, and a second refusal would only
    // spend the turn budget on the same argument.
    let mut evidence_retried = false;
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
        // A steer lands here, between one step settling and the next request
        // going out, so the tool call that was running finished normally and its
        // result is already in the conversation. Injecting rather than aborting
        // keeps one run, which means one orientation and one status sentence:
        // the model reads the new instruction as the next thing the user said,
        // with everything it has already learned still in front of it.
        apply_pending_steer(&session, &sink, &run_id).await;
        // Everything this request depends on is captured once, before it goes
        // out. A deferred change landing mid-request cannot reach the in-flight
        // turn, because the turn no longer reads session state.
        let surface = tool_surface(&session);
        let tools = surface.specs().to_vec();
        let mut prepared = prepared_messages(&session, &tools, &sink).await?;
        let mut snapshot = Arc::new(turn_snapshot(
            surface.clone(),
            &prepared,
            harness_bucket.clone(),
        ));
        sink.emit(context_event(&session, prepared.usage));
        // What can still be refused decides how this step's text streams. An
        // evidence-required run that has not yet called a tool is the one
        // window where an entire answer can be refused — a finished answer
        // there is a fabrication by definition — so everything is withheld
        // until the step resolves. Every other guided step withholds one
        // status line's worth for the cadence and streams live past it: the
        // user watches the answer arrive, and what the model wrote is what
        // they see.
        let hold = if harness_bucket.is_none() {
            HoldPolicy::None
        } else if orient.evidence_required
            && !evidence_retried
            && summary["toolCalls"].as_u64().unwrap_or(0) == 0
        {
            HoldPolicy::All
        } else {
            HoldPolicy::Bounded
        };
        let mut response = stream_veil_chat(
            &session,
            &sink,
            snapshot.messages(),
            snapshot.tools(),
            VeilRequestOptions {
                max_output_tokens: snapshot.max_output_tokens(),
                include_tools: true,
                harness_bucket: snapshot.harness_bucket().map(str::to_owned),
                hold,
            },
        )
        .await;
        if response
            .as_ref()
            .is_err_and(|error| context_overflow(error))
        {
            public_progress.before_context_recovery(&session, &sink, &mut summary);
            if recover_from_overflow(&session, &tools).await {
                prepared = prepared_messages(&session, &tools, &sink).await?;
                // Compaction replaced the conversation state, so the turn is
                // re-snapshotted rather than reusing stale prompt assembly.
                snapshot = Arc::new(turn_snapshot(
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
                        hold,
                    },
                )
                .await;
            }
        }
        let mut result = match response {
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
        record_system_prompt_size(&session, &result).await;
        record_compaction_verdict(&session, &result).await;
        increment(&mut summary, "turns", 1);
        if let Some(event) = observed_context_event(
            &session,
            &result,
            snapshot.max_output_tokens(),
            prepared.usage.breakdown,
        ) {
            sink.emit(event);
        }
        let calls = result.tool_calls.clone();
        increment(&mut summary, "toolCalls", calls.len() as u64);
        if !calls.is_empty() {
            if result.hold_broken {
                // The step's prose already streamed live, so anything still
                // held completes a paragraph the user is mid-way through
                // reading. It stands where it streamed, verbatim; the desktop
                // closes the working block above it rather than relocating
                // text under the reader.
                release_held_text(&sink, &session, &mut result);
            } else {
                // A short preamble on a tool step is dropped unshown. The
                // orientation opens the run and the tool rows narrate every
                // call after it — that is the whole status story, with nothing
                // asked of the model and nothing injected into its context.
                result.held_text.clear();
            }
        }
        if calls.is_empty() {
            if looks_like_unstructured_tool_call(&result.content) {
                let call = ToolCall {
                    id: format!("protocol-error-{}", summary["turns"].as_u64().unwrap_or(0)),
                    name: "invalid_tool_syntax".into(),
                    arguments: json!({}),
                    index: 0,
                };
                let error = "Assistant text contained raw tool syntax. Use one available structured tool with its declared JSON schema.";
                append_assistant_turn(
                    &session,
                    assistant_tool_message(std::slice::from_ref(&call)),
                    &result,
                )
                .await;
                session
                    .messages
                    .lock()
                    .await
                    .push(json!({"role":"tool","tool_call_id":call.id,"content":error}));
                publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
                continue;
            }
            // An evidence-required bucket that produces a finished answer
            // before any tool has run has described a workspace it never
            // looked at. A live repo_orient run did exactly this: a confident,
            // wholly invented architecture summary, zero tool calls, and
            // nothing in the transcript marking it as unverified. The answer is
            // refused once and the plan is restarted rather than shipped.
            if orient.evidence_required
                && !evidence_retried
                && summary["toolCalls"].as_u64().unwrap_or(0) == 0
                && !result.content.trim().is_empty()
            {
                evidence_retried = true;
                let call = ToolCall {
                    id: format!(
                        "missing-evidence-{}",
                        summary["turns"].as_u64().unwrap_or(0)
                    ),
                    name: "missing_workspace_evidence".into(),
                    arguments: json!({}),
                    index: 0,
                };
                let error = "That answer used no workspace evidence: this turn has run no tool, so nothing in it is verified. Discard it and start the playbook now with real tool calls. Describe only what a tool result actually shows.";
                append_assistant_turn(
                    &session,
                    assistant_tool_message(std::slice::from_ref(&call)),
                    &result,
                )
                .await;
                session
                    .messages
                    .lock()
                    .await
                    .push(json!({"role":"tool","tool_call_id":call.id,"content":error}));
                sink.emit(json!({
                    "type": "orient.evidence_retry",
                    "taskId": session.task_id,
                    "bucket": orient.bucket(),
                    "at": now_iso()
                }));
                publish_step_settled(&session, &sink, &run_id, &mut step_index, "completed").await;
                continue;
            }
            // No refusal applied, so the step stands and anything held for
            // it is shown. The branch above returns without releasing,
            // which is what leaves a refused answer with no trace in the UI.
            //
            // There is deliberately no text inspection here. An earlier
            // version scanned the answer's closing sentences for announcement
            // phrasings ("I will now examine…") and refused or trimmed them —
            // and every live model promptly used a phrasing the list did not
            // have. Word lists are a treadmill and they are English-only; a
            // harness stays model-agnostic by reacting to structure (tool
            // calls made, text length, step shape), never to wording. Ending
            // on the answer is the playbook's guidance to give, and whatever
            // the model writes is what the user sees, verbatim.
            release_held_text(&sink, &session, &mut result);
            if !result.content.trim().is_empty() {
                increment(
                    &mut summary,
                    "assistantTextChars",
                    result.content.len() as u64,
                );
                append_assistant_turn(
                    &session,
                    json!({"role":"assistant","content":result.content}),
                    &result,
                )
                .await;
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
            append_assistant_turn(&session, assistant_tool_message(&calls), &result).await;
            let mut messages = session.messages.lock().await;
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
        append_assistant_turn(&session, assistant_tool_message(&calls), &result).await;
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
