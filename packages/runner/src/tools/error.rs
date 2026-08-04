use serde_json::Value;

use super::redact_text;

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub status: String,
    pub code: Option<String>,
    pub summary: String,
    pub content: String,
    pub details: Option<Value>,
    pub continuation: Option<Value>,
    pub exit_code: Option<i32>,
    pub error_message: Option<String>,
}

impl ToolResult {
    pub(super) fn success(summary: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            status: "success".into(),
            code: None,
            summary: summary.into(),
            content: content.into(),
            details: None,
            continuation: None,
            exit_code: Some(0),
            error_message: None,
        }
    }

    pub(super) fn success_detailed(
        summary: impl Into<String>,
        content: impl Into<String>,
        details: Option<Value>,
        continuation: Option<Value>,
    ) -> Self {
        Self {
            status: "success".into(),
            code: None,
            summary: summary.into(),
            content: content.into(),
            details,
            continuation,
            exit_code: Some(0),
            error_message: None,
        }
    }

    pub(super) fn failure(status: &str, code: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            status: status.into(),
            code: Some(code.into()),
            summary: "tool".into(),
            content: redact_text(&format!("Tool failed: {message}"), 600),
            details: None,
            continuation: None,
            exit_code: Some(1),
            error_message: Some(message),
        }
    }

    pub fn model_text(&self, tool_name: &str) -> String {
        let mut lines = vec![format!(
            "{}: {} ({})",
            tool_name,
            self.summary,
            if self.status == "success" {
                "ok"
            } else {
                &self.status
            }
        )];
        if let Some(code) = &self.code {
            lines.push(format!("Error code: {code}"));
        }
        if !self.content.trim().is_empty() {
            lines.push(self.content.clone());
        }
        if let Some(continuation) = &self.continuation
            && let Ok(encoded) = serde_json::to_string(continuation)
        {
            lines.push(format!("Continuation: {encoded}"));
        }
        lines.join("\n")
    }
}

#[derive(Debug)]
pub(super) struct ToolError {
    pub(super) status: &'static str,
    pub(super) code: &'static str,
    pub(super) message: String,
    /// Typed failure payload. Consumers read this instead of parsing the
    /// model-facing message.
    pub(super) details: Option<Value>,
}

impl ToolError {
    pub(super) fn validation(message: impl Into<String>) -> Self {
        Self {
            status: "validation_error",
            code: "invalid_arguments",
            message: message.into(),
            details: None,
        }
    }

    pub(super) fn validation_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: "validation_error",
            code,
            message: message.into(),
            details: None,
        }
    }

    pub(super) fn permission(message: impl Into<String>) -> Self {
        Self {
            status: "permission_denied",
            code: "permission_denied",
            message: message.into(),
            details: None,
        }
    }

    pub(super) fn aborted(message: impl Into<String>) -> Self {
        Self {
            status: "aborted",
            code: "aborted",
            message: message.into(),
            details: None,
        }
    }

    pub(super) fn policy(message: impl Into<String>) -> Self {
        Self {
            status: "policy_blocked",
            code: "policy_blocked",
            message: message.into(),
            details: None,
        }
    }

    pub(super) fn runtime(message: impl Into<String>) -> Self {
        Self {
            status: "runtime_error",
            code: "runtime_error",
            message: message.into(),
            details: None,
        }
    }

    pub(super) fn runtime_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: "runtime_error",
            code,
            message: message.into(),
            details: None,
        }
    }
}

impl From<String> for ToolError {
    fn from(message: String) -> Self {
        Self::validation(message)
    }
}

impl From<&str> for ToolError {
    fn from(message: &str) -> Self {
        Self::validation(message)
    }
}

pub(super) type ToolExecutionResult = Result<ToolResult, ToolError>;
