use chrono::Utc;
use serde_json::Value;

pub type RunnerEvent = Value;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn empty_summary() -> Value {
    serde_json::json!({ "status":"completed", "turns":0, "assistantTextChars":0, "progressTextChars":0, "toolCalls":0, "failedToolCalls":0, "attempts":[] })
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
