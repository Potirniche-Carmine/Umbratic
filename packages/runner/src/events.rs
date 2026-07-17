use chrono::Utc;
use serde_json::Value;

pub type RunnerEvent = Value;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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
