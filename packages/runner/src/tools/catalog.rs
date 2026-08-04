//! One definition per tool. The model-facing JSON schema and the executing
//! validator are both generated from these entries, so a limit or field list
//! exists exactly once and cannot drift between what is declared and what is
//! enforced. Executors receive already-validated, already-bounded input and
//! never re-clamp.

use serde_json::{Map, Value, json};

/// The declared shape of one argument.
#[derive(Clone, Copy, Debug)]
pub(super) enum FieldKind {
    Text {
        min_len: u64,
        max_len: Option<u64>,
    },
    Integer {
        minimum: i64,
        maximum: i64,
    },
    Boolean,
    /// A fixed set of allowed string values.
    Choice(&'static [&'static str]),
    /// The approved-executable ids, resolved once when the surface is frozen.
    ProgramId,
    TextArray {
        max_items: u64,
        max_len: u64,
    },
    /// `edits[]`: objects of exactly `oldText` and `newText`.
    EditArray {
        max_items: u64,
    },
}

#[derive(Clone, Copy, Debug)]
pub(super) struct ToolField {
    pub(super) name: &'static str,
    pub(super) kind: FieldKind,
    pub(super) required: bool,
    pub(super) description: &'static str,
}

const fn text(name: &'static str, required: bool, description: &'static str) -> ToolField {
    ToolField {
        name,
        kind: FieldKind::Text {
            min_len: 1,
            max_len: None,
        },
        required,
        description,
    }
}

const fn bounded_text(
    name: &'static str,
    required: bool,
    min_len: u64,
    max_len: u64,
    description: &'static str,
) -> ToolField {
    ToolField {
        name,
        kind: FieldKind::Text {
            min_len,
            max_len: Some(max_len),
        },
        required,
        description,
    }
}

const fn integer(
    name: &'static str,
    minimum: i64,
    maximum: i64,
    description: &'static str,
) -> ToolField {
    ToolField {
        name,
        kind: FieldKind::Integer { minimum, maximum },
        required: false,
        description,
    }
}

const fn choice(
    name: &'static str,
    required: bool,
    values: &'static [&'static str],
    description: &'static str,
) -> ToolField {
    ToolField {
        name,
        kind: FieldKind::Choice(values),
        required,
        description,
    }
}

/// Every limit in the contract, declared once.
pub(super) const MAX_READ_LINES: i64 = 2_000;
pub(super) const MAX_LISTING_ITEMS: i64 = 200;
pub(super) const MAX_EDITS_PER_CALL: u64 = 64;
pub(super) const MAX_PROGRAM_ARGS: u64 = 128;
pub(super) const MAX_PROGRAM_ARG_LEN: u64 = 4_096;
pub(super) const MIN_TIMEOUT_MS: i64 = 100;
pub(super) const MAX_TIMEOUT_MS: i64 = 1_800_000;
pub(super) const MAX_PATTERN_LEN: u64 = 512;
pub(super) const MAX_GREP_CONTEXT: i64 = 5;
pub(super) const MAX_SKILL_CHUNK: i64 = 8 * 1024;
pub(super) const MAX_ATTACHMENT_CHUNK: i64 = 64 * 1024;
pub(super) const MAX_CONTEXT_CHUNK: i64 = 64 * 1024;
pub(super) const MAX_GRAPH_DEPTH: i64 = 8;

/// What gates a tool's presence on the frozen surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Gate {
    /// Present when the named capability is enabled for the session.
    Capability(&'static str),
    /// Enabled by `command`, and only when at least one executable is approved.
    ApprovedPrograms,
    /// Present when the session declares at least one skill.
    Skills,
    /// Present when the chat has an attachment directory.
    Attachments,
    /// Always present: the context store is declared at task start and answers
    /// `context_not_available` when it holds nothing.
    Always,
    /// Present when the capability is enabled and its service started.
    Service(&'static str),
}

#[derive(Clone, Copy, Debug)]
pub(super) struct ToolDefinition {
    pub(super) name: &'static str,
    pub(super) gate: Gate,
    /// The declared shape of this tool's output. Compaction reads this instead
    /// of sniffing the model-facing text for prefixes like "Directory:".
    pub(super) kind: &'static str,
    pub(super) description: &'static str,
    pub(super) fields: &'static [ToolField],
}

pub(super) const TOOLS: &[ToolDefinition] = &[
    ToolDefinition {
        name: "read",
        kind: "file",
        gate: Gate::Capability("read"),
        description: "Read one UTF-8 workspace text file. Send exactly one JSON object with path and optional one-based line offset and limit. Returns raw file text with original line endings and no line-number prefixes. Never list directories; use ls. If a result is partial, continue with the reported nextOffset.",
        fields: &[
            text("path", true, "Workspace-relative file path."),
            integer(
                "offset",
                1,
                i64::MAX,
                "One-based line offset to begin reading.",
            ),
            integer(
                "limit",
                1,
                MAX_READ_LINES,
                "Maximum number of lines to return.",
            ),
        ],
    },
    ToolDefinition {
        name: "ls",
        kind: "directory",
        gate: Gate::Capability("ls"),
        description: "List one workspace directory non-recursively. Entries are returned in lexical order with / on directories. Use find for recursion. Continue with nextOffset when truncated.",
        fields: &[
            text(
                "path",
                true,
                "Workspace-relative directory path. Use \".\" for the workspace root.",
            ),
            integer("offset", 1, i64::MAX, "One-based entry offset."),
            integer("limit", 1, MAX_LISTING_ITEMS, "Maximum entries to return."),
        ],
    },
    ToolDefinition {
        name: "find",
        kind: "search",
        gate: Gate::Capability("find"),
        description: "Find workspace paths by one explicit glob under path. Returns stable sorted relative paths. No fuzzy query language.",
        fields: &[
            text("path", true, "Workspace-relative directory or file scope."),
            bounded_text(
                "glob",
                true,
                1,
                MAX_PATTERN_LEN,
                "One include glob, such as **/*.rs.",
            ),
            integer("limit", 1, MAX_LISTING_ITEMS, "Maximum paths to return."),
        ],
    },
    ToolDefinition {
        name: "grep",
        kind: "search",
        gate: Gate::Capability("grep"),
        description: "Search text with one pattern in literal or regex mode under path. Optional glob, caseSensitive, context lines, and limit. Returns path:line: text rows.",
        fields: &[
            bounded_text(
                "pattern",
                true,
                1,
                MAX_PATTERN_LEN,
                "Exact literal or regex pattern.",
            ),
            choice(
                "mode",
                true,
                &["literal", "regex"],
                "How pattern is interpreted.",
            ),
            text("path", true, "Workspace-relative file or directory scope."),
            bounded_text("glob", false, 0, MAX_PATTERN_LEN, "Optional include glob."),
            ToolField {
                name: "caseSensitive",
                kind: FieldKind::Boolean,
                required: false,
                description: "Match case exactly.",
            },
            integer(
                "context",
                0,
                MAX_GREP_CONTEXT,
                "Context lines around each match.",
            ),
            integer("limit", 1, MAX_LISTING_ITEMS, "Maximum rows to return."),
        ],
    },
    ToolDefinition {
        name: "write",
        kind: "plain_text",
        gate: Gate::Capability("write"),
        description: "Create or replace one workspace text file after permission. Send exactly path and content. Parents are created after approval; the write is staged and installed atomically.",
        fields: &[
            text("path", true, "Workspace-relative destination file."),
            ToolField {
                name: "content",
                kind: FieldKind::Text {
                    min_len: 0,
                    max_len: None,
                },
                required: true,
                description: "Complete UTF-8 file content.",
            },
        ],
    },
    ToolDefinition {
        name: "edit",
        kind: "diff",
        gate: Gate::Capability("edit"),
        description: "Apply one or more exact replacements to one workspace file after permission. Send exactly path and edits[]. Each oldText must match the same original snapshot uniquely and without overlap. Copy oldText verbatim from the latest read result, including its line endings. No fuzzy matching.",
        fields: &[
            text("path", true, "Workspace-relative file to edit."),
            ToolField {
                name: "edits",
                kind: FieldKind::EditArray {
                    max_items: MAX_EDITS_PER_CALL,
                },
                required: true,
                description: "Exact replacements to apply to one original snapshot.",
            },
        ],
    },
    ToolDefinition {
        name: "apply_patch",
        kind: "diff",
        gate: Gate::Capability("edit"),
        description: "Apply one exact Begin Patch document to workspace files after permission. Send exactly the patch field. Every hunk must match uniquely. Do not send edit fields.",
        fields: &[text(
            "patch",
            true,
            "A complete *** Begin Patch through *** End Patch document.",
        )],
    },
    ToolDefinition {
        name: "lsp",
        kind: "json",
        gate: Gate::Service("lsp"),
        description: "Query read-only language-server evidence. Use one-based line and character positions. Verify returned locations with read before an edit.",
        fields: &[
            choice(
                "action",
                true,
                &["definition", "references", "hover", "symbols"],
                "The query to run.",
            ),
            text("path", false, "Workspace-relative file path."),
            integer("line", 1, i64::MAX, "One-based line."),
            integer("character", 1, i64::MAX, "One-based character."),
            text("query", false, "Symbol query for the symbols action."),
            integer(
                "limit",
                1,
                MAX_LISTING_ITEMS,
                "Maximum locations to return.",
            ),
        ],
    },
    ToolDefinition {
        name: "workspace_graph",
        kind: "json",
        gate: Gate::Service("workspace_graph"),
        description: "Query bounded source-backed workspace graph evidence.",
        fields: &[
            choice(
                "action",
                true,
                &["summary", "query", "explain", "path", "affected"],
                "The query to run.",
            ),
            text("query", false, "Free-text query for the query action."),
            text("symbol", false, "Symbol name for the explain action."),
            text("from", false, "Start node for the path action."),
            text("to", false, "End node for the path action."),
            ToolField {
                name: "files",
                kind: FieldKind::TextArray {
                    max_items: MAX_LISTING_ITEMS as u64,
                    max_len: MAX_PATTERN_LEN,
                },
                required: false,
                description: "Workspace-relative files.",
            },
            ToolField {
                name: "symbols",
                kind: FieldKind::TextArray {
                    max_items: MAX_LISTING_ITEMS as u64,
                    max_len: MAX_PATTERN_LEN,
                },
                required: false,
                description: "Symbol names.",
            },
            integer("depth", 1, MAX_GRAPH_DEPTH, "Traversal depth."),
            integer("limit", 1, MAX_LISTING_ITEMS, "Maximum nodes to return."),
            integer("maxDepth", 1, MAX_GRAPH_DEPTH, "Maximum traversal depth."),
            choice(
                "direction",
                false,
                &["incoming", "outgoing", "both"],
                "Edge direction.",
            ),
        ],
    },
    ToolDefinition {
        name: "command",
        kind: "log",
        gate: Gate::Capability("command"),
        description: "",
        fields: &[
            text("command", true, "One complete shell command."),
            integer(
                "timeoutMs",
                MIN_TIMEOUT_MS,
                MAX_TIMEOUT_MS,
                "Bounded execution timeout.",
            ),
        ],
    },
    ToolDefinition {
        name: "run_program",
        kind: "log",
        gate: Gate::ApprovedPrograms,
        description: "",
        fields: &[
            ToolField {
                name: "programId",
                kind: FieldKind::ProgramId,
                required: true,
                description: "One exact executable id from this enum.",
            },
            ToolField {
                name: "args",
                kind: FieldKind::TextArray {
                    max_items: MAX_PROGRAM_ARGS,
                    max_len: MAX_PROGRAM_ARG_LEN,
                },
                required: false,
                description: "Argument values only, in process order. Do not include the executable id.",
            },
            integer(
                "timeoutMs",
                MIN_TIMEOUT_MS,
                MAX_TIMEOUT_MS,
                "Bounded execution timeout.",
            ),
        ],
    },
    ToolDefinition {
        name: "read_skill",
        kind: "file",
        gate: Gate::Skills,
        description: "Read complete instructions for one enabled skill before applying it.",
        fields: &[
            text("skillId", true, "One enabled skill id."),
            text("resource", false, "Optional skill-relative resource path."),
            integer("offset", 0, i64::MAX, "Zero-based byte offset."),
            integer("limit", 1, MAX_SKILL_CHUNK, "Maximum bytes to return."),
        ],
    },
    ToolDefinition {
        name: "read_attachment",
        kind: "file",
        gate: Gate::Attachments,
        description: "Read a bounded byte range from a complete text attachment in the current chat. For whole-document work, continue from each reported offset until Read status is complete.",
        fields: &[
            text(
                "attachmentId",
                true,
                "One attachment id from the current chat.",
            ),
            integer("offset", 0, i64::MAX, "Zero-based byte offset."),
            integer("limit", 1, MAX_ATTACHMENT_CHUNK, "Maximum bytes to return."),
        ],
    },
    ToolDefinition {
        name: "retrieve_context",
        kind: "plain_text",
        gate: Gate::Always,
        description: "Retrieve a bounded window of exact compacted local tool output by its reported hash. Returns context_not_available when no output has been compacted yet.",
        fields: &[
            text(
                "hash",
                true,
                "The hash reported by a compacted tool result.",
            ),
            integer("offset", 0, i64::MAX, "Zero-based byte offset."),
            integer("limit", 1, MAX_CONTEXT_CHUNK, "Maximum bytes to return."),
        ],
    },
];

pub(super) fn definition(name: &str) -> Option<&'static ToolDefinition> {
    TOOLS.iter().find(|tool| tool.name == name)
}

/// A validation failure carrying the typed detail the model needs to repair the
/// call in one step: which tool, which field, what was expected.
#[derive(Clone, Debug)]
pub(crate) struct ContractViolation {
    /// Stable terminal code. Consumers switch on this, never on the message.
    pub(crate) code: &'static str,
    pub(crate) tool: String,
    pub(crate) field: Option<String>,
    pub(crate) expected: String,
    pub(crate) allowed_fields: Vec<String>,
}

impl ContractViolation {
    pub(crate) fn message(&self) -> String {
        match &self.field {
            Some(field) => format!(
                "{} argument {field} is invalid: expected {}. Allowed fields: {}.",
                self.tool,
                self.expected,
                self.allowed_fields.join(", ")
            ),
            None => format!(
                "{} call is invalid: expected {}. Allowed fields: {}.",
                self.tool,
                self.expected,
                self.allowed_fields.join(", ")
            ),
        }
    }

    pub(crate) fn details(&self) -> Value {
        json!({
            "code": self.code,
            "tool": self.tool,
            "field": self.field,
            "expected": self.expected,
            "allowedFields": self.allowed_fields,
        })
    }
}

impl ToolDefinition {
    fn allowed_fields(&self) -> Vec<String> {
        self.fields
            .iter()
            .map(|field| field.name.to_owned())
            .collect()
    }

    fn violation(&self, field: Option<&str>, expected: impl Into<String>) -> ContractViolation {
        ContractViolation {
            code: "invalid_arguments",
            tool: self.name.to_owned(),
            field: field.map(str::to_owned),
            expected: expected.into(),
            allowed_fields: self.allowed_fields(),
        }
    }

    /// The model-facing schema. `programs` supplies the frozen approved-executable
    /// ids; it is the only part of a declaration that varies by session.
    pub(super) fn schema(&self, description: &str, programs: &[String]) -> Value {
        let mut properties = Map::new();
        let mut required = Vec::new();
        for field in self.fields {
            properties.insert(field.name.to_owned(), field_schema(field, programs));
            if field.required {
                required.push(Value::String(field.name.to_owned()));
            }
        }
        json!({
            "type": "function",
            "function": {
                "name": self.name,
                "description": description,
                // Exactly name, description, and parameters. Provider-specific
                // flags such as vLLM strict mode are added by Veil, which owns
                // the final runtime request.
                "parameters": {
                    "type": "object",
                    "properties": Value::Object(properties),
                    "required": Value::Array(required),
                    "additionalProperties": false
                }
            }
        })
    }

    /// The generated validator. Runs on every execution path, not just batches.
    pub(super) fn validate(
        &self,
        arguments: &Map<String, Value>,
        programs: &[String],
    ) -> Result<(), ContractViolation> {
        for (name, value) in arguments {
            let Some(field) = self.fields.iter().find(|field| field.name == name) else {
                return Err(self.violation(Some(name), "a declared field"));
            };
            validate_field(self, field, value, programs)?;
        }
        for field in self.fields {
            if field.required && !arguments.contains_key(field.name) {
                return Err(self.violation(Some(field.name), "a required value"));
            }
        }
        Ok(())
    }
}

fn field_schema(field: &ToolField, programs: &[String]) -> Value {
    let mut schema = match field.kind {
        FieldKind::Text { min_len, max_len } => {
            let mut value = json!({"type": "string", "minLength": min_len});
            if let Some(max_len) = max_len {
                value["maxLength"] = json!(max_len);
            }
            value
        }
        FieldKind::Integer { minimum, maximum } => {
            let mut value = json!({"type": "integer", "minimum": minimum});
            if maximum != i64::MAX {
                value["maximum"] = json!(maximum);
            }
            value
        }
        FieldKind::Boolean => json!({"type": "boolean"}),
        FieldKind::Choice(values) => json!({"type": "string", "enum": values}),
        FieldKind::ProgramId => json!({"type": "string", "enum": programs}),
        FieldKind::TextArray { max_items, max_len } => json!({
            "type": "array",
            "maxItems": max_items,
            "items": {"type": "string", "maxLength": max_len}
        }),
        FieldKind::EditArray { max_items } => json!({
            "type": "array",
            "minItems": 1,
            "maxItems": max_items,
            "items": {
                "type": "object",
                "properties": {
                    "oldText": {"type": "string", "minLength": 1, "description": "Exact current text to replace."},
                    "newText": {"type": "string", "description": "Replacement text."}
                },
                "required": ["oldText", "newText"],
                "additionalProperties": false
            }
        }),
    };
    if !field.description.is_empty() {
        schema["description"] = json!(field.description);
    }
    schema
}

fn validate_field(
    tool: &ToolDefinition,
    field: &ToolField,
    value: &Value,
    programs: &[String],
) -> Result<(), ContractViolation> {
    match field.kind {
        FieldKind::Text { min_len, max_len } => {
            let text = value
                .as_str()
                .ok_or_else(|| tool.violation(Some(field.name), "a string"))?;
            let length = text.chars().count() as u64;
            if length < min_len {
                return Err(tool.violation(
                    Some(field.name),
                    format!("a string of at least {min_len} characters"),
                ));
            }
            if let Some(max_len) = max_len
                && length > max_len
            {
                return Err(tool.violation(
                    Some(field.name),
                    format!("a string of at most {max_len} characters"),
                ));
            }
            Ok(())
        }
        FieldKind::Integer { minimum, maximum } => {
            let number = value
                .as_i64()
                .ok_or_else(|| tool.violation(Some(field.name), "an integer"))?;
            if number < minimum || number > maximum {
                return Err(tool.violation(
                    Some(field.name),
                    format!("an integer between {minimum} and {maximum}"),
                ));
            }
            Ok(())
        }
        FieldKind::Boolean => value
            .as_bool()
            .map(|_| ())
            .ok_or_else(|| tool.violation(Some(field.name), "a boolean")),
        FieldKind::Choice(values) => {
            let text = value
                .as_str()
                .ok_or_else(|| tool.violation(Some(field.name), "a string"))?;
            if values.contains(&text) {
                Ok(())
            } else {
                Err(tool.violation(Some(field.name), format!("one of {}", values.join(", "))))
            }
        }
        FieldKind::ProgramId => {
            let text = value
                .as_str()
                .ok_or_else(|| tool.violation(Some(field.name), "a string"))?;
            if programs.iter().any(|program| program == text) {
                Ok(())
            } else {
                Err(tool.violation(Some(field.name), format!("one of {}", programs.join(", "))))
            }
        }
        FieldKind::TextArray { max_items, max_len } => {
            let items = value
                .as_array()
                .ok_or_else(|| tool.violation(Some(field.name), "an array of strings"))?;
            if items.len() as u64 > max_items {
                return Err(tool.violation(Some(field.name), format!("at most {max_items} items")));
            }
            for item in items {
                let text = item
                    .as_str()
                    .ok_or_else(|| tool.violation(Some(field.name), "an array of strings"))?;
                if text.chars().count() as u64 > max_len || text.contains('\0') {
                    return Err(tool.violation(
                        Some(field.name),
                        format!("strings of at most {max_len} characters without NUL"),
                    ));
                }
            }
            Ok(())
        }
        FieldKind::EditArray { max_items } => {
            let items = value.as_array().ok_or_else(|| {
                tool.violation(Some(field.name), "an array of {oldText, newText} objects")
            })?;
            if items.is_empty() {
                return Err(tool.violation(Some(field.name), "at least one edit"));
            }
            if items.len() as u64 > max_items {
                return Err(tool.violation(Some(field.name), format!("at most {max_items} edits")));
            }
            for item in items {
                let object = item.as_object().ok_or_else(|| {
                    tool.violation(Some(field.name), "an array of {oldText, newText} objects")
                })?;
                if let Some(unknown) = object
                    .keys()
                    .find(|key| key.as_str() != "oldText" && key.as_str() != "newText")
                {
                    return Err(tool.violation(
                        Some(field.name),
                        format!("only oldText and newText, but received {unknown}"),
                    ));
                }
                let old = object.get("oldText").and_then(Value::as_str);
                if old.is_none_or(str::is_empty) {
                    return Err(tool.violation(Some(field.name), "a non-empty oldText"));
                }
                if !object.get("newText").is_some_and(Value::is_string) {
                    return Err(tool.violation(Some(field.name), "a string newText"));
                }
            }
            Ok(())
        }
    }
}
