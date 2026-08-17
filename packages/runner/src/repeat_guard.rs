use serde_json::json;

use crate::tools::{ToolCall, ToolResult, tool_capability_name};

const MAX_REPEATED_READ_ONLY_TURNS: usize = 10;
const MAX_REPEATED_MUTATING_TURNS: usize = 2;

#[derive(Default)]
pub(crate) struct RepeatGuard {
    previous_signature: Option<String>,
    repeated_count: usize,
}

impl RepeatGuard {
    pub(crate) fn should_stop(&mut self, calls: &[ToolCall], results: &[ToolResult]) -> bool {
        let Some(signature) = completed_exchange_signature(calls, results) else {
            self.previous_signature = None;
            self.repeated_count = 0;
            return false;
        };
        if self.previous_signature.as_deref() == Some(&signature) {
            self.repeated_count += 1;
        } else {
            self.previous_signature = Some(signature);
            self.repeated_count = 1;
        }
        self.repeated_count >= repeated_exchange_limit(calls)
    }
}

fn repeated_exchange_limit(calls: &[ToolCall]) -> usize {
    if calls.iter().any(|call| {
        matches!(
            tool_capability_name(&call.name),
            Some("write" | "edit" | "command")
        ) || mutating_artifact(call)
    }) {
        MAX_REPEATED_MUTATING_TURNS
    } else {
        MAX_REPEATED_READ_ONLY_TURNS
    }
}

/// `artifact` is one tool with a read action and two write actions, so the
/// capability name cannot decide this on its own. The strict limit is what
/// makes the QA repair loop terminate: the spec or the ops have to change
/// between rounds, and rebuilding the identical file twice is the failure this
/// catches.
fn mutating_artifact(call: &ToolCall) -> bool {
    call.name == "artifact"
        && call
            .arguments
            .get("action")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|action| action == "create" || action == "edit")
}

fn completed_exchange_signature(calls: &[ToolCall], results: &[ToolResult]) -> Option<String> {
    if !results.iter().any(|result| result.status == "success") {
        return None;
    }
    Some(
        calls
            .iter()
            .zip(results)
            .map(|(call, result)| {
                json!({
                    "tool": call.name,
                    "arguments": call.arguments,
                    "result": {
                        "summary": result.summary,
                        "content": result.content,
                        "status": result.status,
                        "errorCode": result.code,
                        "errorMessage": result.error_message,
                        "exitCode": result.exit_code,
                        "details": result.details,
                        "continuation": result.continuation,
                    }
                })
                .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn call(name: &str) -> Vec<ToolCall> {
        vec![ToolCall {
            id: "call-1".into(),
            name: name.into(),
            arguments: json!({"path":"README.md"}),
            index: 0,
        }]
    }

    fn result(output: &str, status: &str) -> Vec<ToolResult> {
        vec![ToolResult {
            summary: "README.md".into(),
            location: None,
            content: output.into(),
            status: status.into(),
            code: (status != "success").then(|| "invalid_arguments".into()),
            error_message: (status != "success").then(|| "failed".into()),
            exit_code: Some(i32::from(status != "success")),
            details: None::<Value>,
            continuation: None,
        }]
    }

    #[test]
    fn changed_read_results_reset_the_lenient_guard() {
        let calls = call("read");
        let mut guard = RepeatGuard::default();
        for _ in 0..9 {
            assert!(!guard.should_stop(&calls, &result("first", "success")));
        }
        assert!(!guard.should_stop(&calls, &result("changed", "success")));
        for _ in 0..8 {
            assert!(!guard.should_stop(&calls, &result("changed", "success")));
        }
        assert!(guard.should_stop(&calls, &result("changed", "success")));
    }

    #[test]
    fn mutating_tools_stay_strict_and_failures_use_the_failure_guard() {
        let calls = call("edit");
        let mut guard = RepeatGuard::default();
        assert!(!guard.should_stop(&calls, &result("done", "success")));
        assert!(guard.should_stop(&calls, &result("done", "success")));
        assert!(!guard.should_stop(&calls, &result("failed", "validation_error")));
    }
}
