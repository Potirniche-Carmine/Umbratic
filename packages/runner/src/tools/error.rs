use serde_json::Value;

use super::redact_text;

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub title: String,
    pub output: String,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub exit_code: Option<i32>,
    pub details: Option<Value>,
}

impl ToolResult {
    pub(super) fn success(title: impl Into<String>, output: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            output: output.into(),
            status: "success".into(),
            error_code: None,
            error_message: None,
            exit_code: Some(0),
            details: None,
        }
    }

    pub(super) fn failure(status: &str, code: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            title: "tool".into(),
            output: redact_text(&format!("Tool failed: {message}"), 600),
            status: status.into(),
            error_code: Some(code.into()),
            error_message: Some(message),
            exit_code: Some(1),
            details: None,
        }
    }
}

#[derive(Debug)]
pub(super) struct ToolError {
    pub(super) status: &'static str,
    pub(super) code: &'static str,
    pub(super) message: String,
}

impl ToolError {
    pub(super) fn validation(message: impl Into<String>) -> Self {
        Self {
            status: "validation_error",
            code: "invalid_arguments",
            message: message.into(),
        }
    }

    pub(super) fn permission(message: impl Into<String>) -> Self {
        Self {
            status: "permission_denied",
            code: "permission_denied",
            message: message.into(),
        }
    }

    pub(super) fn policy(message: impl Into<String>) -> Self {
        Self {
            status: "policy_blocked",
            code: "policy_blocked",
            message: message.into(),
        }
    }

    pub(super) fn runtime(message: impl Into<String>) -> Self {
        Self {
            status: "runtime_error",
            code: "runtime_error",
            message: message.into(),
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
