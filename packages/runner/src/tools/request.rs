use std::path::Path;

use serde_json::{Map, Value};

use crate::{
    policy::redact_text,
    safety::{SafetyDecisionV1, evaluate_command},
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
request_type!(SearchRequest);
request_type!(LspRequest);
request_type!(WorkspaceGraphRequest);
request_type!(ReadSkillRequest);
request_type!(RetrieveContextRequest);

#[derive(Debug, Clone)]
pub(super) struct CommandRequest {
    arguments: Map<String, Value>,
    command: String,
    safety: SafetyDecisionV1,
}

#[derive(Debug, Clone)]
pub(super) enum ToolRequest {
    Read(ReadRequest),
    ReadAttachment(ReadAttachmentRequest),
    Write(WriteRequest),
    Edit(EditRequest),
    Search(SearchRequest),
    Lsp(LspRequest),
    WorkspaceGraph(WorkspaceGraphRequest),
    Command(CommandRequest),
    ReadSkill(ReadSkillRequest),
    RetrieveContext(RetrieveContextRequest),
}

impl ToolRequest {
    pub(super) fn parse(name: &str, value: &Value, cwd: &Path) -> Result<Self, String> {
        let arguments = parse_arguments(value)?;
        validate_arguments(name, &arguments)?;
        let request = match name {
            "read" => Self::Read(ReadRequest {
                primary: string_arg(&arguments, &["filePath"]),
                arguments,
            }),
            "read_attachment" => Self::ReadAttachment(ReadAttachmentRequest {
                primary: string_arg(&arguments, &["attachmentId"]),
                arguments,
            }),
            "write" => Self::Write(WriteRequest {
                primary: string_arg(&arguments, &["filePath"]),
                arguments,
            }),
            "edit" | "apply_patch" => {
                let patch_mode = name == "apply_patch";
                let mut arguments = arguments;
                if patch_mode {
                    arguments.insert("mode".into(), Value::String("patch".into()));
                }
                Self::Edit(EditRequest {
                    primary: if patch_mode {
                        "patch".into()
                    } else {
                        string_arg(&arguments, &["filePath"])
                    },
                    arguments,
                })
            }
            "search" => Self::Search(SearchRequest {
                primary: string_arg(&arguments, &["query"]),
                arguments,
            }),
            "lsp" => Self::Lsp(LspRequest {
                primary: format!(
                    "{} {}",
                    string_arg(&arguments, &["action"]),
                    string_arg(&arguments, &["filePath"])
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
            _ => return Err(format!("Unknown tool: {name}")),
        };
        Ok(request)
    }

    pub(super) fn summary(&self) -> String {
        match self {
            Self::Read(request) => format!("read {}", request.primary),
            Self::ReadAttachment(request) => format!("read attachment {}", request.primary),
            Self::Write(request) => format!("write {}", request.primary),
            Self::Edit(request) => format!("edit {}", request.primary),
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
            Self::Write(_) | Self::Edit(_) => "edit",
            _ => "read",
        }
    }

    pub(super) fn capability_name(&self) -> Option<&'static str> {
        match self {
            Self::Read(_) => Some("read"),
            Self::Write(_) => Some("write"),
            Self::Edit(_) => Some("edit"),
            Self::Search(_) => Some("search"),
            Self::Lsp(_) => Some("lsp"),
            Self::WorkspaceGraph(_) => Some("workspace_graph"),
            Self::Command(_) => Some("command"),
            Self::ReadSkill(_) | Self::ReadAttachment(_) | Self::RetrieveContext(_) => None,
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

    pub(super) fn safety(&self) -> &SafetyDecisionV1 {
        &self.safety
    }
}

pub fn tool_capability_name(name: &str) -> Option<&'static str> {
    match name {
        "read" => Some("read"),
        "write" => Some("write"),
        "edit" | "apply_patch" => Some("edit"),
        "search" => Some("search"),
        "lsp" => Some("lsp"),
        "workspace_graph" => Some("workspace_graph"),
        "command" | "run_program" => Some("command"),
        "read_skill" | "read_attachment" | "retrieve_context" => None,
        _ => None,
    }
}

pub(super) fn parse_arguments(value: &Value) -> Result<Map<String, Value>, String> {
    if let Some(object) = value.as_object() {
        return Ok(object.clone());
    }
    let Some(text) = value.as_str().map(str::trim) else {
        return Err("Tool arguments must be a JSON object.".into());
    };
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| "Tool arguments must be valid JSON object.".into())
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

fn validate_arguments(name: &str, input: &Map<String, Value>) -> Result<(), String> {
    let allowed: &[&str] = match name {
        "read" => &["filePath", "offset", "limit", "depth"],
        "write" => &["filePath", "content"],
        "edit" => &["filePath", "oldText", "newText"],
        "apply_patch" => &["patch"],
        "search" => &[
            "query",
            "queries",
            "path",
            "glob",
            "exclude",
            "caseSensitive",
            "limit",
        ],
        "lsp" => &["action", "filePath", "line", "character", "query", "limit"],
        "workspace_graph" => &[
            "action",
            "query",
            "symbol",
            "from",
            "to",
            "files",
            "symbols",
            "depth",
            "limit",
            "maxDepth",
            "direction",
        ],
        "command" => &["command", "timeoutMs"],
        "run_program" => &["programId", "args", "timeoutMs"],
        "read_skill" => &["skillId", "resource", "offset", "limit"],
        "read_attachment" => &["attachmentId", "offset", "limit"],
        "retrieve_context" => &["hash", "offset", "limit"],
        _ => return Err(format!("Unknown tool: {name}")),
    };
    if let Some(key) = input.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{name} received unknown argument {key}"));
    }
    for key in [
        "offset",
        "limit",
        "depth",
        "maxDepth",
        "timeoutMs",
        "line",
        "character",
    ] {
        if input.contains_key(key) && input.get(key).and_then(Value::as_u64).is_none() {
            return Err(format!(
                "{name} argument {key} must be a non-negative integer"
            ));
        }
    }
    let required = match name {
        "read" | "write" => vec![string_arg(input, &["filePath"])],
        "edit" => vec![
            string_arg(input, &["filePath"]),
            string_arg(input, &["oldText"]),
        ],
        "apply_patch" => vec![string_arg(input, &["patch"])],
        "command" => vec![string_arg(input, &["command"])],
        "run_program" => vec![string_arg(input, &["programId"])],
        "read_skill" => vec![string_arg(input, &["skillId"])],
        "read_attachment" => vec![string_arg(input, &["attachmentId"])],
        "retrieve_context" => vec![string_arg(input, &["hash"])],
        "workspace_graph" | "lsp" => vec![string_arg(input, &["action"])],
        _ => vec![],
    };
    if required.iter().any(String::is_empty) {
        return Err(format!("{name} is missing a required string argument"));
    }
    for key in ["glob", "exclude"] {
        if let Some(value) = input.get(key)
            && !value.is_string()
        {
            return Err(format!("{name} argument {key} must be a string"));
        }
    }
    if input.contains_key("caseSensitive")
        && !input.get("caseSensitive").is_some_and(Value::is_boolean)
    {
        return Err("search argument caseSensitive must be a boolean".into());
    }
    if name == "search" {
        if input
            .get("query")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
            && input.get("queries").is_some()
        {
            return Err("search accepts query or queries, not both".into());
        }
        if let Some(queries) = input.get("queries") {
            let Some(queries) = queries.as_array() else {
                return Err("search argument queries must be an array of strings".into());
            };
            if queries.is_empty()
                || queries.len() > 32
                || queries.iter().any(|query| {
                    !query.as_str().is_some_and(|value| {
                        !value.trim().is_empty()
                            && value.chars().count() <= 256
                            && !value.contains('\0')
                    })
                })
            {
                return Err("search queries exceed the bounded string term limits".into());
            }
        }
    }
    if name == "read_attachment"
        && ["offset", "limit"].iter().any(|key| {
            input.contains_key(*key) && input.get(*key).and_then(Value::as_u64).is_none()
        })
    {
        return Err("read_attachment offset and limit must be non-negative integers".into());
    }
    if name == "write" && !input.get("content").is_some_and(Value::is_string) {
        return Err("write argument content must be a string".into());
    }
    if name == "run_program"
        && let Some(args) = input.get("args")
    {
        let Some(args) = args.as_array() else {
            return Err("run_program argument args must be an array of strings".into());
        };
        if args.len() > 128
            || args.iter().any(|argument| {
                !argument
                    .as_str()
                    .is_some_and(|value| value.len() <= 4096 && !value.contains('\0'))
            })
        {
            return Err("run_program args exceed the bounded string argument limits".into());
        }
    }
    if name == "edit" && !input.get("newText").is_some_and(Value::is_string) {
        return Err("edit newText must be a string".into());
    }
    Ok(())
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
