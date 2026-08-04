use chrono::Utc;
use serde_json::{Value, json};

pub type RunnerEvent = Value;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn empty_summary() -> Value {
    json!({
        "status": "completed",
        "turns": 0,
        "assistantTextChars": 0,
        "progressTextChars": 0,
        "toolCalls": 0,
        "failedToolCalls": 0,
        "attempts": []
    })
}

pub fn increment(summary: &mut Value, key: &str, amount: u64) {
    let current = summary.get(key).and_then(Value::as_u64).unwrap_or(0);
    summary[key] = Value::from(current + amount);
}

pub fn event_type(event: &RunnerEvent) -> &str {
    event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
}

pub fn task_id(event: &RunnerEvent) -> Option<&str> {
    event.get("taskId").and_then(Value::as_str)
}

pub fn step_settled_event(
    task_id: &str,
    session_id: &str,
    run_id: &str,
    step_id: &str,
    outcome: &str,
    conversation_state: Value,
) -> RunnerEvent {
    json!({
        "type": "step.settled",
        "taskId": task_id,
        "sessionId": session_id,
        "runId": run_id,
        "stepId": step_id,
        "outcome": outcome,
        "conversationState": conversation_state,
        "at": now_iso()
    })
}

pub fn run_settled_event(
    task_id: &str,
    session_id: &str,
    run_id: &str,
    outcome: &str,
    summary: Option<Value>,
    error_code: Option<&str>,
) -> RunnerEvent {
    json!({
        "type": "run.settled",
        "taskId": task_id,
        "sessionId": session_id,
        "runId": run_id,
        "outcome": outcome,
        "summary": summary,
        "errorCode": error_code,
        "at": now_iso()
    })
}

#[allow(clippy::too_many_arguments)]
pub fn run_queue_updated_event(
    task_id: &str,
    session_id: &str,
    run_id: Option<&str>,
    action_id: &str,
    action: &str,
    disposition: &str,
    pending_steer: bool,
    follow_up_count: usize,
    follow_up_capacity: usize,
    reason_code: Option<&str>,
) -> RunnerEvent {
    json!({
        "type": "run.queue.updated",
        "taskId": task_id,
        "sessionId": session_id,
        "runId": run_id,
        "actionId": action_id,
        "action": action,
        "disposition": disposition,
        "pendingSteer": pending_steer,
        "followUpCount": follow_up_count,
        "followUpCapacity": follow_up_capacity,
        "reasonCode": reason_code,
        "at": now_iso()
    })
}
