use std::path::Path;

use serde_json::{Map, Value};

use super::{ToolSurface, catalog::ContractViolation};
use crate::{
    policy::redact_text,
    safety::{SafetyDecision, evaluate_command},
};

macro_rules! request_type {
    ($name:ident) => {
        #[derive(Debug, Clone)]
        pub(super) struct $name {
            pub(super) arguments: Map<String, Value>,
            pub(super) primary: String,
        }
    };
}

request_type!(ReadRequest);
request_type!(ReadAttachmentRequest);
request_type!(WriteRequest);
request_type!(EditRequest);
request_type!(ApplyPatchRequest);
request_type!(LsRequest);
request_type!(FindRequest);
request_type!(GrepRequest);
request_type!(SearchRequest);
request_type!(LspRequest);
request_type!(WorkspaceGraphRequest);
request_type!(ReadSkillRequest);
request_type!(RetrieveContextRequest);

#[derive(Debug, Clone)]
pub(super) struct CommandRequest {
    arguments: Map<String, Value>,
    command: String,
    safety: SafetyDecision,
}

#[derive(Debug, Clone)]
pub(super) enum ToolRequest {
    Read(ReadRequest),
    ReadAttachment(ReadAttachmentRequest),
    Write(WriteRequest),
    Edit(EditRequest),
    ApplyPatch(ApplyPatchRequest),
    Ls(LsRequest),
    Find(FindRequest),
    Grep(GrepRequest),
    Search(SearchRequest),
    Lsp(LspRequest),
    WorkspaceGraph(WorkspaceGraphRequest),
    Command(CommandRequest),
    ReadSkill(ReadSkillRequest),
    RetrieveContext(RetrieveContextRequest),
}

impl ToolRequest {
    pub(super) fn parse(
        name: &str,
        value: &Value,
        cwd: &Path,
        surface: &ToolSurface,
    ) -> Result<Self, ContractViolation> {
        let arguments = parse_arguments(value).map_err(|expected| ContractViolation {
            code: "invalid_arguments",
            tool: name.to_owned(),
            field: None,
            expected,
            allowed_fields: Vec::new(),
        })?;
        // The generated validator, on every execution path.
        surface.validate(name, &arguments)?;
        let request = match name {
            "read" => Self::Read(ReadRequest {
                primary: string_arg(&arguments, &["path"]),
                arguments,
            }),
            "read_attachment" => Self::ReadAttachment(ReadAttachmentRequest {
                primary: string_arg(&arguments, &["attachmentId"]),
                arguments,
            }),
            "write" => Self::Write(WriteRequest {
                primary: string_arg(&arguments, &["path"]),
                arguments,
            }),
            "edit" => Self::Edit(EditRequest {
                primary: string_arg(&arguments, &["path"]),
                arguments,
            }),
            "apply_patch" => Self::ApplyPatch(ApplyPatchRequest {
                primary: "patch".into(),
                arguments,
            }),
            "ls" => Self::Ls(LsRequest {
                primary: string_arg(&arguments, &["path"]),
                arguments,
            }),
            "find" => Self::Find(FindRequest {
                primary: string_arg(&arguments, &["glob"]),
                arguments,
            }),
            "grep" => Self::Grep(GrepRequest {
                primary: string_arg(&arguments, &["pattern"]),
                arguments,
            }),
            "search" => Self::Search(SearchRequest {
                primary: string_arg(&arguments, &["query"]),
                arguments,
            }),
            "lsp" => Self::Lsp(LspRequest {
                primary: format!(
                    "{} {}",
                    string_arg(&arguments, &["action"]),
                    string_arg(&arguments, &["path"])
                )
                .trim()
                .to_owned(),
                arguments,
            }),
            "workspace_graph" => Self::WorkspaceGraph(WorkspaceGraphRequest {
                primary: string_arg(&arguments, &["action"]),
                arguments,
            }),
            "command" | "run_program" => {
                let command = command_display(&arguments);
                let safety = evaluate_command(&command, cwd);
                Self::Command(CommandRequest {
                    arguments,
                    command,
                    safety,
                })
            }
            "read_skill" => Self::ReadSkill(ReadSkillRequest {
                primary: string_arg(&arguments, &["skillId"]),
                arguments,
            }),
            "retrieve_context" => Self::RetrieveContext(RetrieveContextRequest {
                primary: string_arg(&arguments, &["hash"]),
                arguments,
            }),
            _ => {
                return Err(ContractViolation {
                    code: "unknown_tool",
                    tool: name.to_owned(),
                    field: None,
                    expected: "a declared tool".to_owned(),
                    allowed_fields: Vec::new(),
                });
            }
        };
        Ok(request)
    }

    pub(super) fn summary(&self) -> String {
        match self {
            Self::Read(request) => format!("read {}", request.primary),
            Self::ReadAttachment(request) => format!("read attachment {}", request.primary),
            Self::Write(request) => format!("write {}", request.primary),
            Self::Edit(request) => format!("edit {}", request.primary),
            Self::ApplyPatch(request) => format!("edit {}", request.primary),
            Self::Ls(request) => format!("ls {}", request.primary),
            Self::Find(request) => format!("find {}", request.primary),
            Self::Grep(request) => format!("grep {}", request.primary),
            Self::Search(request) => format!("search {}", request.primary),
            Self::Lsp(request) => format!("lsp {}", request.primary),
            Self::Command(request) => redact_text(&request.command, 320),
            Self::WorkspaceGraph(request) => {
                format!("workspace_graph {}", request.primary)
            }
            Self::ReadSkill(request) => format!("read_skill {}", request.primary),
            Self::RetrieveContext(request) => {
                format!("retrieve_context {}", request.primary)
            }
        }
    }

    pub(super) fn command_class(&self) -> &'static str {
        match self {
            Self::Command(request) => request.safety.command_class,
            Self::Write(_) | Self::Edit(_) | Self::ApplyPatch(_) => "edit",
            _ => "read",
        }
    }

    /// The validated arguments, used for batch duplicate-signature detection.
    pub(super) fn arguments(&self) -> &Map<String, Value> {
        match self {
            Self::Read(request) => &request.arguments,
            Self::ReadAttachment(request) => &request.arguments,
            Self::Write(request) => &request.arguments,
            Self::Edit(request) => &request.arguments,
            Self::ApplyPatch(request) => &request.arguments,
            Self::Ls(request) => &request.arguments,
            Self::Find(request) => &request.arguments,
            Self::Grep(request) => &request.arguments,
            Self::Search(request) => &request.arguments,
            Self::Lsp(request) => &request.arguments,
            Self::WorkspaceGraph(request) => &request.arguments,
            Self::Command(request) => &request.arguments,
            Self::ReadSkill(request) => &request.arguments,
            Self::RetrieveContext(request) => &request.arguments,
        }
    }

    pub(super) fn emits_own_output(&self) -> bool {
        matches!(self, Self::Command(_))
    }
}

impl CommandRequest {
    pub(super) fn arguments(&self) -> &Map<String, Value> {
        &self.arguments
    }

    pub(super) fn safety(&self) -> &SafetyDecision {
        &self.safety
    }
}

pub fn tool_capability_name(name: &str) -> Option<&'static str> {
    match name {
        "read" => Some("read"),
        "write" => Some("write"),
        "edit" | "apply_patch" => Some("edit"),
        "ls" => Some("ls"),
        "find" => Some("find"),
        "grep" => Some("grep"),
        "search" => Some("search"),
        "lsp" => Some("lsp"),
        "workspace_graph" => Some("workspace_graph"),
        "command" | "run_program" => Some("command"),
        "read_skill" | "read_attachment" | "retrieve_context" => None,
        _ => None,
    }
}

pub(super) fn parse_arguments(value: &Value) -> Result<Map<String, Value>, String> {
    match value {
        Value::Object(object) => Ok(object.clone()),
        Value::String(text) => {
            let trimmed = text.trim();
            let parsed: Value = serde_json::from_str(trimmed)
                .map_err(|_| "Tool arguments must be valid JSON object.".to_owned())?;
            parsed
                .as_object()
                .cloned()
                .ok_or_else(|| "Tool arguments must be one JSON object.".into())
        }
        _ => Err("Tool arguments must be a JSON object.".into()),
    }
}

fn string_arg(input: &Map<String, Value>, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| input.get(*name).and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}

fn string_list_arg(input: &Map<String, Value>, names: &[&str]) -> Vec<String> {
    names
        .iter()
        .find_map(|name| input.get(*name))
        .map(|value| match value {
            Value::String(value) => vec![value.clone()],
            Value::Array(values) => values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        })
        .unwrap_or_default()
}

pub(super) fn command_display(input: &Map<String, Value>) -> String {
    let command = string_arg(input, &["command"]);
    if !command.is_empty() {
        return command;
    }
    let program_id = string_arg(input, &["programId"]);
    let args = string_list_arg(input, &["args"]);
    std::iter::once(program_id)
        .chain(args)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
