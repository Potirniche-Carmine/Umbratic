//! Context accounting for one request: what the meter is told, and what the
//! next request is measured against.
//!
//! The rule the whole module exists to enforce is that a provider-reported
//! `prompt_tokens` is not an input to an estimate — it *is* the size of the
//! settled context. Once a response lands, every later estimate anchors to it
//! and guesses only at the messages appended since. A mutation of the settled
//! prefix (compaction, folding an exchange) invalidates the anchor outright
//! rather than being blended into it.

use std::sync::atomic::Ordering;

use serde_json::{Value, json};

use crate::{
    config::provider_endpoint_url,
    context::{
        ContextBreakdown, ContextCalibration, ContextEstimateInput, ContextUsageEstimate,
        SystemPromptSize, UsageAnchor, adaptive_output_reserve, estimate_context_usage,
        request_profile_fingerprint,
    },
    events::now_iso,
    session::Session,
    veil_client::VeilChatResult,
};

/// Two measured verdicts are enough to conclude the context cannot get below
/// the trigger, because the incompressible floor is system prompt plus tools.
pub(crate) const MAX_COMPACTION_STRIKES: u32 = 2;

pub(crate) fn skill_profile(session: &Session) -> Vec<Value> {
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

pub(crate) fn session_route(session: &Session) -> String {
    provider_endpoint_url(&session.config.provider)
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|_| {
            session
                .config
                .provider
                .chat_endpoint_path
                .clone()
                .unwrap_or_default()
        })
}

/// The session-scoped inputs to an estimate, read once per estimate so the
/// three mutexes are never held across the arithmetic.
#[derive(Debug, Clone, Default)]
pub(crate) struct SessionEstimateState {
    pub(crate) calibration: Option<ContextCalibration>,
    pub(crate) anchor: Option<UsageAnchor>,
    pub(crate) system_prompt: Option<SystemPromptSize>,
}

pub(crate) async fn estimate_state(session: &Session) -> SessionEstimateState {
    SessionEstimateState {
        calibration: session.context_calibration.lock().await.clone(),
        anchor: *session.usage_anchor.lock().await,
        system_prompt: *session.system_prompt_size.lock().await,
    }
}

pub(crate) fn request_estimate(
    session: &Session,
    messages: &[Value],
    tools: &[Value],
    state: &SessionEstimateState,
) -> (ContextUsageEstimate, String) {
    let skills = skill_profile(session);
    let mut usage = estimate_context_usage(ContextEstimateInput {
        messages,
        tools,
        skills: &skills,
        context_length: session.config.context_length,
        max_response_tokens: session.config.max_response_tokens,
        protected_prompt_reserve_tokens: session.config.protected_prompt_reserve_tokens,
        system_prompt: state.system_prompt,
        anchor: state.anchor,
    });
    let profile_fingerprint = request_profile_fingerprint(
        &session.config.provider.model_id,
        &session_route(session),
        session.config.context_length,
        session.config.protected_prompt_reserve_tokens,
        tools,
        &skills,
    );
    // Calibration is the fallback for an unanchored prompt only. An anchored
    // number is already a measurement, so scaling it would corrupt it.
    if let Some(calibration) = state.calibration.as_ref().filter(|_| !usage.anchored) {
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

pub(crate) fn compaction_blocked(session: &Session) -> bool {
    session.compaction_strikes.load(Ordering::SeqCst) >= MAX_COMPACTION_STRIKES
}

/// Whether the settled prefix was rewritten and has not been re-measured yet.
///
/// This is the only thing that distinguishes "compacted, size unknown until the
/// next response" from "this session has simply never had a measurement" — a
/// resumed conversation is unanchored too. The runner owns the distinction, so
/// it reports it rather than leaving the UI to infer it from event history.
pub(crate) fn awaiting_measurement(session: &Session) -> bool {
    session.awaiting_observed_usage.load(Ordering::SeqCst)
}

pub(crate) fn context_event(session: &Session, usage: ContextUsageEstimate) -> Value {
    let mut event = usage.event();
    let object = event
        .as_object_mut()
        .expect("a usage event is always an object");
    object.insert("type".into(), json!("context.usage"));
    object.insert("taskId".into(), json!(session.task_id));
    object.insert(
        "compactionBlocked".into(),
        json!(compaction_blocked(session)),
    );
    object.insert(
        "awaitingMeasurement".into(),
        json!(awaiting_measurement(session)),
    );
    object.insert("at".into(), json!(now_iso()));
    event
}

pub(crate) fn observed_context_event(
    session: &Session,
    result: &VeilChatResult,
    reserve_tokens: u64,
    mut breakdown: ContextBreakdown,
) -> Option<Value> {
    let prompt_tokens = result.prompt_tokens?;
    // The response carries a better system-prompt row than the request could:
    // the first turn of a session assembles its estimate before Veil has ever
    // reported the size of its own prefix.
    if let Some(system_prompt_tokens) = result.system_prompt_tokens {
        breakdown.system_prompt_tokens = system_prompt_tokens;
        breakdown.system_prompt_exact = result.system_prompt_tokens_exact;
    }
    // The rows must sum to the measured prompt: a meter whose categories
    // exceed its measured headline reads as broken.
    let breakdown = breakdown.reconciled_to(prompt_tokens);
    Some(json!({
        "type": "context.usage",
        "taskId": session.task_id,
        "contextLength": session.config.context_length,
        "contentTokens": prompt_tokens,
        "promptTokens": prompt_tokens,
        "completionTokens": result.completion_tokens.unwrap_or(0),
        "reserveTokens": reserve_tokens,
        "protectedTokens": breakdown.system_prompt_tokens.min(prompt_tokens),
        "estimatedTokens": prompt_tokens.saturating_add(reserve_tokens),
        "phase": "observed",
        "source": "provider",
        "confidence": "high",
        "anchored": true,
        "compactionBlocked": compaction_blocked(session),
        // This event is itself the measurement, so nothing is being awaited.
        "awaitingMeasurement": false,
        "breakdown": breakdown.event(),
        "at": now_iso(),
    }))
}

/// Records Veil's size for its own protected prefix. It is stable for the
/// session, so the first response that reports it replaces the configured
/// stand-in for every later preflight.
pub(crate) async fn record_system_prompt_size(session: &Session, result: &VeilChatResult) {
    let Some(tokens) = result.system_prompt_tokens else {
        return;
    };
    *session.system_prompt_size.lock().await = Some(SystemPromptSize {
        tokens,
        exact: result.system_prompt_tokens_exact,
    });
}

/// Anchors the session to a completed response. `anchor_len` is the message
/// count once the assistant turn has been appended, so everything the provider
/// measured sits below it and only later messages are estimated.
pub(crate) async fn set_usage_anchor(
    session: &Session,
    result: &VeilChatResult,
    anchor_len: usize,
) {
    let Some(prompt_tokens) = result.prompt_tokens else {
        return;
    };
    *session.usage_anchor.lock().await = Some(UsageAnchor {
        prompt_tokens,
        completion_tokens: result.completion_tokens.unwrap_or(0),
        anchor_len,
    });
    session
        .awaiting_observed_usage
        .store(false, Ordering::SeqCst);
}

/// Invalidates the anchor because the settled prefix it described no longer
/// exists. The sentinel keeps a merely heuristic estimate from compacting
/// again before the next response proves the real, smaller size.
pub(crate) async fn clear_usage_anchor(session: &Session) {
    *session.usage_anchor.lock().await = None;
    session
        .awaiting_observed_usage
        .store(true, Ordering::SeqCst);
}
