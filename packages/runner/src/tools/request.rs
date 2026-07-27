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
        let name = canonical_tool_name(name);
        let arguments = parse_arguments(value)?;
        validate_arguments(&name, &arguments)?;
        let request = match name.as_str() {
            "read" => Self::Read(ReadRequest {
                primary: string_arg(&arguments, &["filePath", "file_path", "path", "directory"]),
                arguments,
            }),
            "read_attachment" => Self::ReadAttachment(ReadAttachmentRequest {
                primary: string_arg(&arguments, &["attachmentId"]),
                arguments,
            }),
            "write" => Self::Write(WriteRequest {
                primary: string_arg(&arguments, &["filePath", "file_path", "path"]),
                arguments,
            }),
            "edit" => {
                let patch_mode = arguments.get("mode").and_then(Value::as_str) == Some("patch")
                    || (arguments.contains_key("patch")
                        && !["filePath", "file_path", "path"]
                            .iter()
                            .any(|key| arguments.contains_key(*key)));
                Self::Edit(EditRequest {
                    primary: if patch_mode {
                        "patch".into()
                    } else {
                        string_arg(&arguments, &["filePath", "file_path", "path"])
                    },
                    arguments,
                })
            }
            "search" => Self::Search(SearchRequest {
                primary: string_arg(&arguments, &["query", "pattern", "term", "text"]),
                arguments,
            }),
            "lsp" => Self::Lsp(LspRequest {
                primary: format!(
                    "{} {}",
                    string_arg(&arguments, &["action"]),
                    string_arg(&arguments, &["filePath", "path"])
                )
                .trim()
                .to_owned(),
                arguments,
            }),
            "workspace_graph" => Self::WorkspaceGraph(WorkspaceGraphRequest {
                primary: string_arg(&arguments, &["action"]),
                arguments,
            }),
            "command" => {
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

    pub(super) fn is_internal(&self) -> bool {
        matches!(
            self,
            Self::ReadSkill(_) | Self::ReadAttachment(_) | Self::RetrieveContext(_)
        )
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

pub fn canonical_tool_name(name: &str) -> String {
    let normalized = name.trim().to_ascii_lowercase().replace(['-', '.'], "_");
    match normalized.as_str() {
        "read_file" | "list_files" | "list_directory" | "ls" => "read".into(),
        "write_file" | "create_file" => "write".into(),
        "edit_file" | "replace_text" | "apply_patch" => "edit".into(),
        "search_files" | "find_files" | "grep" | "rg" => "search".into(),
        "run_command" | "shell" | "bash" | "powershell" => "command".into(),
        _ => normalized,
    }
}

pub(super) fn parse_arguments(value: &Value) -> Result<Map<String, Value>, String> {
    if let Some(object) = value.as_object() {
        return Ok(object.clone());
    }
    let Some(mut text) = value.as_str().map(str::trim) else {
        return Err("Tool arguments must be a JSON object.".into());
    };
    if text.starts_with("```") && text.ends_with("```") {
        text = text
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
    }
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
        "read" => &[
            "filePath",
            "file_path",
            "path",
            "directory",
            "offset",
            "limit",
            "depth",
        ],
        "write" => &["filePath", "file_path", "path", "content", "text"],
        "edit" => &[
            "mode",
            "filePath",
            "file_path",
            "path",
            "oldText",
            "old_string",
            "old",
            "find",
            "newText",
            "new_string",
            "new",
            "replace",
            "patch",
        ],
        "search" => &[
            "query",
            "pattern",
            "term",
            "text",
            "path",
            "directory",
            "filePath",
            "glob",
            "filePattern",
            "exclude",
            "caseSensitive",
            "limit",
            "maxResults",
        ],
        "lsp" => &[
            "action",
            "filePath",
            "path",
            "line",
            "character",
            "query",
            "limit",
        ],
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
        "command" => &["command", "cmd", "script", "programId", "args", "timeoutMs"],
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
        "maxResults",
        "depth",
        "maxDepth",
        "timeoutMs",
        "line",
        "character",
    ] {
        if input.contains_key(key) && !input.get(key).is_some_and(Value::is_number) {
            return Err(format!("{name} argument {key} must be a number"));
        }
    }
    let required = match name {
        "read" => vec![string_arg(
            input,
            &["filePath", "file_path", "path", "directory"],
        )],
        "write" => vec![string_arg(input, &["filePath", "file_path", "path"])],
        "search" => vec![
            string_arg(input, &["query", "pattern", "term", "text"]),
            string_arg(input, &["path", "directory", "filePath"]),
            string_list_arg(input, &["glob", "filePattern"]).join(""),
        ],
        "command" => vec![],
        "read_skill" => vec![string_arg(input, &["skillId"])],
        "read_attachment" => vec![string_arg(input, &["attachmentId"])],
        "retrieve_context" => vec![string_arg(input, &["hash"])],
        "workspace_graph" | "lsp" => vec![string_arg(input, &["action"])],
        "edit"
            if input.get("mode").and_then(Value::as_str) == Some("patch")
                || (input.contains_key("patch")
                    && !["filePath", "file_path", "path"]
                        .iter()
                        .any(|key| input.contains_key(*key))) =>
        {
            vec![string_arg(input, &["patch"])]
        }
        "edit" => vec![
            string_arg(input, &["filePath", "file_path", "path"]),
            string_arg(input, &["oldText", "old_string", "old", "find"]),
        ],
        _ => vec![],
    };
    let missing_required = if name == "search" {
        required.iter().all(String::is_empty)
    } else {
        required.iter().any(String::is_empty)
    };
    if missing_required {
        return Err(format!("{name} is missing a required string argument"));
    }
    for key in ["glob", "filePattern", "exclude"] {
        if let Some(value) = input.get(key)
            && !value.is_string()
            && !value
                .as_array()
                .is_some_and(|values| values.iter().all(Value::is_string))
        {
            return Err(format!(
                "{name} argument {key} must be a string or an array of strings"
            ));
        }
    }
    if input.contains_key("caseSensitive")
        && !input.get("caseSensitive").is_some_and(Value::is_boolean)
    {
        return Err("search argument caseSensitive must be a boolean".into());
    }
    if name == "read_attachment"
        && ["offset", "limit"].iter().any(|key| {
            input.contains_key(*key) && input.get(*key).and_then(Value::as_u64).is_none()
        })
    {
        return Err("read_attachment offset and limit must be non-negative integers".into());
    }
    if name == "write"
        && !input
            .get("content")
            .or_else(|| input.get("text"))
            .is_some_and(Value::is_string)
    {
        return Err("write argument content must be a string".into());
    }
    if name == "command" {
        let command = string_arg(input, &["command", "cmd", "script"]);
        let program_id = string_arg(input, &["programId"]);
        if command.is_empty() && program_id.is_empty() {
            return Err("command requires command or programId".into());
        }
        if !command.is_empty() && !program_id.is_empty() {
            return Err("command must use either command or programId, not both".into());
        }
        if let Some(args) = input.get("args") {
            if program_id.is_empty() {
                return Err("command args require programId".into());
            }
            let Some(args) = args.as_array() else {
                return Err("command argument args must be an array of strings".into());
            };
            if args.len() > 128
                || args.iter().any(|argument| {
                    !argument
                        .as_str()
                        .is_some_and(|value| value.len() <= 4096 && !value.contains('\0'))
                })
            {
                return Err("command args exceed the bounded string argument limits".into());
            }
        }
    }
    if name == "edit" {
        let mode = input
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("replace");
        if !matches!(mode, "replace" | "patch") {
            return Err("edit mode must be replace or patch".into());
        }
        if mode == "replace"
            && !(input
                .get("newText")
                .or_else(|| input.get("new_string"))
                .or_else(|| input.get("new"))
                .or_else(|| input.get("replace"))
                .is_some_and(Value::is_string))
        {
            return Err("edit newText must be a string".into());
        }
    }
    Ok(())
}

pub(super) fn command_display(input: &Map<String, Value>) -> String {
    let command = string_arg(input, &["command", "cmd", "script"]);
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
