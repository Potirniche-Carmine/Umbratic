use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    config::DiagnosticsConfig,
    events::{RunnerEvent, event_type, now_iso, task_id},
    policy::{redact_text, short_hash_value},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsMetadata {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<PathBuf>,
}

#[derive(Debug)]
pub struct RunnerDiagnostics {
    config: DiagnosticsConfig,
    log_path: Option<PathBuf>,
    failed: Mutex<bool>,
}

fn safe_component(value: &str) -> String {
    let safe: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "_.-".contains(character) {
                character
            } else {
                '-'
            }
        })
        .collect();
    safe.trim_matches('-')
        .chars()
        .take(80)
        .collect::<String>()
        .chars()
        .collect::<String>()
}

impl RunnerDiagnostics {
    pub fn new(config: DiagnosticsConfig, cwd: &std::path::Path, task_id: Option<&str>) -> Self {
        let log_path = if !config.enabled {
            None
        } else if let Some(path) = &config.log_path {
            Some(path.clone())
        } else {
            let name = format!(
                "{}-{}-{}.jsonl",
                safe_component(task_id.unwrap_or("runner")),
                now_iso().replace([':', '.'], "-"),
                std::process::id()
            );
            Some(
                config
                    .directory
                    .clone()
                    .unwrap_or_else(|| cwd.join(".umbratic/diagnostics"))
                    .join(name),
            )
        };
        Self {
            config,
            log_path,
            failed: Mutex::new(false),
        }
    }

    pub fn metadata(&self) -> DiagnosticsMetadata {
        DiagnosticsMetadata {
            enabled: self.config.enabled && !*self.failed.lock().unwrap(),
            log_path: self.log_path.clone(),
        }
    }

    fn data_for(&self, event: &RunnerEvent) -> Option<(String, Map<String, Value>)> {
        let kind = event_type(event);
        if matches!(kind, "assistant.delta" | "assistant.reasoning.delta") {
            return None;
        }
        if kind == "tool.output" {
            let stream = event.get("stream").and_then(Value::as_str).unwrap_or("");
            if self.config.include_tool_output == "none"
                || (self.config.include_tool_output == "stderr" && stream != "stderr")
            {
                return None;
            }
        }
        let level = if kind == "runner.error" {
            "error"
        } else if kind.contains("permission")
            || event.get("outcome").and_then(Value::as_str) == Some("blocked")
        {
            "warn"
        } else {
            "info"
        };
        let mut data = event.as_object().cloned().unwrap_or_default();
        for key in ["type", "taskId", "at"] {
            data.remove(key);
        }
        for key in ["message", "detail", "summary", "errorMessage", "text"] {
            if let Some(Value::String(value)) = data.get_mut(key) {
                *value = redact_text(value, if key == "text" { 1600 } else { 1000 });
            }
        }
        if let Some(Value::String(cwd)) = data.remove("cwd") {
            data.insert("cwdHash".into(), Value::String(short_hash_value(&cwd)));
        }
        Some((level.to_owned(), data))
    }

    pub fn record(&self, event: &RunnerEvent) {
        if !self.config.enabled || *self.failed.lock().unwrap() {
            return;
        }
        let Some(path) = &self.log_path else { return };
        let Some((level, data)) = self.data_for(event) else {
            return;
        };
        if let Some(parent) = path.parent()
            && fs::create_dir_all(parent).is_err()
        {
            *self.failed.lock().unwrap() = true;
            return;
        }
        let record = json!({ "schemaVersion": 1, "source": "umbratic-runner", "level": level, "eventType": event_type(event), "taskId": task_id(event), "at": event.get("at").cloned().unwrap_or_else(|| Value::String(now_iso())), "data": data });
        let result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| {
                writeln!(
                    file,
                    "{}",
                    serde_json::to_string(&record).unwrap_or_default()
                )
            });
        if result.is_err() {
            *self.failed.lock().unwrap() = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(path: PathBuf, include_tool_output: &str) -> DiagnosticsConfig {
        DiagnosticsConfig {
            enabled: true,
            log_path: Some(path),
            directory: None,
            include_tool_output: include_tool_output.into(),
        }
    }

    #[test]
    fn safe_components_remove_control_characters_and_separators() {
        assert_eq!(
            safe_component("task/../../evil\r\nname"),
            "task-..-..-evil--name"
        );
        assert!(safe_component("a".repeat(200).as_str()).len() <= 80);
    }

    #[test]
    fn diagnostics_omit_streaming_text_and_unselected_tool_output() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.jsonl");
        let diagnostics = RunnerDiagnostics::new(
            config(path.clone(), "stderr"),
            directory.path(),
            Some("task"),
        );
        diagnostics.record(
            &json!({"type":"assistant.delta","taskId":"task","text":"secret","at":now_iso()}),
        );
        diagnostics.record(&json!({"type":"tool.output","taskId":"task","stream":"stdout","text":"secret","at":now_iso()}));
        assert!(!path.exists());
        diagnostics.record(&json!({"type":"tool.output","taskId":"task","stream":"stderr","text":"failure","at":now_iso()}));
        let content = fs::read_to_string(path).unwrap();
        assert!(content.contains("tool.output"));
        assert!(content.contains("failure"));
    }

    #[test]
    fn diagnostics_redact_secrets_and_hash_workspace_paths() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.jsonl");
        let diagnostics =
            RunnerDiagnostics::new(config(path.clone(), "all"), directory.path(), Some("task"));
        diagnostics.record(&json!({
            "type":"runner.error",
            "taskId":"task",
            "message":"Authorization: Bearer super-secret-token",
            "cwd":"/private/workspace",
            "at":now_iso()
        }));
        let content = fs::read_to_string(path).unwrap();
        assert!(!content.contains("super-secret-token"));
        assert!(!content.contains("/private/workspace"));
        assert!(content.contains("cwdHash"));
    }

    #[test]
    fn diagnostics_disable_themselves_after_a_write_failure() {
        let directory = tempfile::tempdir().unwrap();
        let diagnostics = RunnerDiagnostics::new(
            config(directory.path().to_path_buf(), "all"),
            directory.path(),
            Some("task"),
        );
        diagnostics.record(
            &json!({"type":"runner.error","taskId":"task","message":"failed","at":now_iso()}),
        );
        assert!(!diagnostics.metadata().enabled);
    }
}
