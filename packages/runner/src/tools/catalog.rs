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
    /// A nested JSON object whose interior belongs to another schema — the
    /// artifact spec, validated by the engine that builds the file. The
    /// contract bounds the size and nothing else, deliberately: a field list
    /// declared here would have to be kept in step with four format schemas,
    /// and an unknown interior key must survive the wire rather than being
    /// rejected by a runner that has no opinion about it.
    JsonObject {
        max_bytes: u64,
    },
    /// A nested JSON array under the same rule, bounded by item count as well.
    JsonArray {
        max_items: u64,
        max_bytes: u64,
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

const fn json_object(name: &'static str, max_bytes: u64, description: &'static str) -> ToolField {
    ToolField {
        name,
        kind: FieldKind::JsonObject { max_bytes },
        required: false,
        description,
    }
}

const fn json_array(
    name: &'static str,
    max_items: u64,
    max_bytes: u64,
    description: &'static str,
) -> ToolField {
    ToolField {
        name,
        kind: FieldKind::JsonArray {
            max_items,
            max_bytes,
        },
        required: false,
        description,
    }
}

/// A cross-field rule. Argument shapes that are individually valid but
/// meaningless together are rejected here rather than resolved by silent
/// precedence in an executor, so the model gets a typed reason instead of a
/// window it did not ask for.
///
/// JSON Schema can express this only through `oneOf`, which is not portable
/// across the strict-mode dialects Veil targets. The rule is therefore stated in
/// the model-facing field descriptions and enforced by the generated validator.
#[derive(Clone, Copy, Debug)]
pub(super) struct FieldRule {
    /// The field this rule constrains. Inert when the field is absent.
    pub(super) field: &'static str,
    /// Fields that must accompany it.
    pub(super) requires: &'static [&'static str],
    /// Fields it may never accompany.
    pub(super) conflicts: &'static [&'static str],
}

/// Every limit in the contract, declared once.
pub(super) const MAX_READ_LINES: i64 = 2_000;
/// What an unqualified `read` returns. A whole file is still reachable through
/// an explicit `limit`, but it is no longer what a bare call costs.
pub(super) const DEFAULT_READ_LINES: i64 = 400;
/// Lines above and below `line` when `radius` is omitted.
pub(super) const DEFAULT_READ_RADIUS: i64 = 20;
/// Derived so a centred window can never exceed the flat line cap.
pub(super) const MAX_READ_RADIUS: i64 = (MAX_READ_LINES - 1) / 2;
pub(super) const MAX_LISTING_ITEMS: i64 = 200;
pub(super) const MAX_EDITS_PER_CALL: u64 = 64;
pub(super) const MAX_PROGRAM_ARGS: u64 = 128;
pub(super) const MAX_PROGRAM_ARG_LEN: u64 = 4_096;
pub(super) const MIN_TIMEOUT_MS: i64 = 100;
pub(super) const MAX_TIMEOUT_MS: i64 = 1_800_000;
pub(super) const MAX_PATTERN_LEN: u64 = 512;
/// Context lines a single match may carry.
pub(super) const MAX_CONTEXT_LINES: i64 = 5;
pub(super) const MAX_SKILL_CHUNK: i64 = 8 * 1024;
pub(super) const MAX_ATTACHMENT_CHUNK: i64 = 64 * 1024;
pub(super) const MAX_CONTEXT_CHUNK: i64 = 64 * 1024;
pub(super) const MAX_GRAPH_DEPTH: i64 = 8;
/// The one bound on how many results an `lsp` query returns. Locations and
/// symbols used to cap at 40 and 50 while the catalog advertised 200, so the
/// model asked for a number it could never get. One value, declared where the
/// model reads it.
pub(crate) const MAX_LSP_RESULTS: i64 = 50;
/// One artifact spec. Large enough for a long deck or a workbook of real
/// sheets, small enough that a runaway generation is refused before it reaches
/// a worker.
pub(crate) const MAX_ARTIFACT_SPEC_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_ARTIFACT_OPS: u64 = 200;
pub(crate) const MAX_ARTIFACT_OPS_BYTES: u64 = 512 * 1024;
pub(crate) const MAX_ARTIFACT_OPTIONS_BYTES: u64 = 8 * 1024;

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
    /// Cross-field rules, applied after every field validates on its own.
    pub(super) rules: &'static [FieldRule],
}

pub(super) const TOOLS: &[ToolDefinition] = &[
    ToolDefinition {
        name: "generate_image",
        gate: Gate::Service("image"),
        kind: "image",
        description: "Generate a PNG using the configured background image model. Use for image creation requests, including @image. Supply a self-contained visual prompt using relevant conversation context, a new workspace-relative .png path, and optional width and height (256–1024, multiples of 32; default 512). The image model loads on demand and releases memory when finished. The result includes the saved image path.",
        fields: &[
            bounded_text("prompt", true, 1, 8000, "Complete visual description."),
            bounded_text(
                "path",
                true,
                1,
                240,
                "New workspace-relative PNG output path.",
            ),
            integer("width", 256, 1024, "Image width, multiple of 32."),
            integer("height", 256, 1024, "Image height, multiple of 32."),
        ],
        rules: &[],
    },
    ToolDefinition {
        name: "read",
        kind: "file",
        gate: Gate::Capability("read"),
        description: "Read part of one UTF-8 workspace text file. path must be a real file you have already seen in an ls, find, or search result; read never accepts a directory, a glob, or a filename you inferred from a language or framework convention. Returns raw file text with original line endings and no line-number prefixes; the covered line range is reported separately. Read a window, not a whole file: when a search hit already tells you where to look, send line with that line number to open a window around it, and raise radius only when the window proves too narrow. Send offset and limit instead to page through a file from a known point, continuing with the reported nextOffset. A call that sets neither returns the first lines of the file and reports its total length. Never list directories; use ls.",
        fields: &[
            text(
                "path",
                true,
                "One exact workspace-relative file path, copied character for character from a listing or search result. Not a directory, not a pattern, never a guessed name.",
            ),
            integer(
                "line",
                1,
                i64::MAX,
                "One-based line to centre a window on, such as the line a search hit reported. Cannot be combined with offset or limit.",
            ),
            integer(
                "radius",
                0,
                MAX_READ_RADIUS,
                "Lines to show above and below line. Requires line.",
            ),
            integer(
                "offset",
                1,
                i64::MAX,
                "One-based line offset to begin reading. Cannot be combined with line.",
            ),
            integer(
                "limit",
                1,
                MAX_READ_LINES,
                "Maximum number of lines to return. Cannot be combined with line.",
            ),
        ],
        rules: &[
            FieldRule {
                field: "line",
                requires: &[],
                conflicts: &["offset", "limit"],
            },
            FieldRule {
                field: "radius",
                requires: &["line"],
                conflicts: &["offset", "limit"],
            },
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
                "One exact workspace-relative directory path, or \".\" for the workspace root. Not a file and not a pattern; ls has no glob argument.",
            ),
            integer("offset", 1, i64::MAX, "One-based entry offset."),
            integer("limit", 1, MAX_LISTING_ITEMS, "Maximum entries to return."),
        ],
        rules: &[],
    },
    ToolDefinition {
        name: "find",
        kind: "search",
        gate: Gate::Capability("find"),
        description: "Find workspace paths by one explicit glob under path. The two arguments split the shell form: the directory goes in path and the pattern goes in glob, so docs/*.md is {\"path\":\"docs\",\"glob\":\"*.md\"}. Returns stable sorted relative paths. No fuzzy query language.",
        fields: &[
            text(
                "path",
                true,
                "Existing workspace-relative directory to search under. Use \".\" for the workspace root. The pattern belongs in glob, never here.",
            ),
            bounded_text(
                "glob",
                true,
                1,
                MAX_PATTERN_LEN,
                "One include glob, matched against both the workspace-relative path and the file name. Examples: **/*.rs, *.md, README*.",
            ),
            integer("limit", 1, MAX_LISTING_ITEMS, "Maximum paths to return."),
        ],
        rules: &[],
    },
    ToolDefinition {
        name: "search",
        kind: "search",
        gate: Gate::Capability("search"),
        description: "Find workspace paths or text. This is the only text-search tool; do not shell out to ripgrep, grep, or find. path mode ranks files and directories by name. content mode matches exact literal text, and regex mode matches a regular expression; both return path:line: rows for each match, plus path:line- rows around them when context is set. Matching is case-insensitive unless query contains an uppercase character, which in regex mode an inline (?i) overrides. Set context to see the code around a match here instead of opening the file, and reserve read for what the surrounding lines do not settle. path is the directory scope and glob is the optional filename filter, so \"find foo in internal/model/*.go\" is {\"query\":\"foo\",\"mode\":\"content\",\"path\":\"internal/model\",\"glob\":\"*.go\"}. Narrow path, glob, or query when a result is truncated.",
        fields: &[
            bounded_text(
                "query",
                true,
                1,
                MAX_PATTERN_LEN,
                "Name fragment for path mode, exact literal text for content mode, or a regular expression for regex mode.",
            ),
            choice(
                "mode",
                true,
                &["path", "content", "regex"],
                "path ranks file and directory names; content and regex search inside files.",
            ),
            text(
                "path",
                true,
                "Existing workspace-relative file or directory to search under. Use \".\" for the workspace root. The filename pattern belongs in glob, never here.",
            ),
            bounded_text(
                "glob",
                false,
                0,
                MAX_PATTERN_LEN,
                "Optional include glob such as *.md, matched against both the workspace-relative path and the file name.",
            ),
            integer(
                "context",
                0,
                MAX_CONTEXT_LINES,
                "Lines of surrounding code to show around each match. Ignored in path mode.",
            ),
            integer(
                "limit",
                1,
                MAX_LISTING_ITEMS,
                "Maximum paths in path mode, or matches in content and regex mode. Defaults to 100 for path and 50 for the others.",
            ),
        ],
        rules: &[],
    },
    ToolDefinition {
        name: "web_search",
        kind: "search",
        gate: Gate::Capability("web_search"),
        description: "Search the public web. Returns titles, URLs, and short snippets. These are not full pages; call web_fetch with one result URL to read a page. An empty result is not proof the subject is missing from the web; never invent a domain. Send exactly query. Private and loopback hosts never appear.",
        fields: &[bounded_text(
            "query",
            true,
            1,
            200,
            "The search query. Distill the question; do not paste the whole user prompt.",
        )],
        rules: &[],
    },
    ToolDefinition {
        name: "web_fetch",
        kind: "plain_text",
        gate: Gate::Capability("web_fetch"),
        description: "Read the text of one public web page. Use a URL from web_search or the user. Returns readable page text, not a screenshot or a browser. Private, loopback, link-local, and credentialed URLs are blocked. Send exactly url.",
        fields: &[bounded_text(
            "url",
            true,
            1,
            2_048,
            "One absolute http or https URL.",
        )],
        rules: &[],
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
        rules: &[],
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
        rules: &[],
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
        rules: &[],
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
            integer("limit", 1, MAX_LSP_RESULTS, "Maximum results to return."),
        ],
        rules: &[],
    },
    ToolDefinition {
        name: "workspace_graph",
        kind: "json",
        gate: Gate::Service("workspace_graph"),
        // The primary steering channel: this text is in context whenever the
        // tool admits, so it carries the decision procedure rather than a
        // description of the data structure.
        description: "Map of this workspace's code: symbols, callers, imports, and which tests cover what. Start with summary. Use affected for blast-radius questions, query for callers and definitions, changes when reviewing a diff. One call returns a complete small answer, so prefer it over grep-and-read chains. Results are evidence with file:line locations; verify with read before editing.",
        fields: &[
            choice(
                "action",
                true,
                &["summary", "query", "explain", "path", "affected", "changes"],
                "The query to run.",
            ),
            text("query", false, "Free-text query for the query action."),
            text("symbol", false, "Symbol name for the explain action."),
            text("from", false, "Start node for the path action."),
            text("to", false, "End node for the path action."),
            integer("depth", 1, MAX_GRAPH_DEPTH, "Traversal depth."),
            integer("limit", 1, MAX_LISTING_ITEMS, "Maximum nodes to return."),
            choice(
                "direction",
                false,
                &["incoming", "outgoing", "both"],
                "Edge direction.",
            ),
        ],
        rules: &[],
    },
    ToolDefinition {
        name: "artifact",
        kind: "json",
        gate: Gate::Service("artifact"),
        description: "Create, inspect, and edit PowerPoint, Word, Excel, and PDF files. Send a spec or a list of ops as JSON; never write library code and never open the file yourself. inspect requires path and returns origin, editSurface, unsupported[], and an outline whose ids the other two actions address. create requires format and spec. edit requires path and ops[]. Inspect any file you did not just create before editing it: editSurface says which ops are allowed, and ids you did not read from an outline do not exist. Results carry qa[]; fix every error and call again, at most three rounds. Nothing is written when ok is false.",
        fields: &[
            choice(
                "action",
                true,
                &["inspect", "create", "edit"],
                "inspect reads a file; create builds a new one from spec; edit applies ops to an existing one.",
            ),
            choice(
                "format",
                false,
                &["pptx", "docx", "xlsx", "pdf"],
                "Required for create. Inferred from the extension of path for inspect and edit.",
            ),
            text(
                "path",
                false,
                "Workspace-relative file to inspect or edit. Required for those two actions.",
            ),
            text(
                "out",
                false,
                "Workspace-relative destination. Defaults to artifacts/<format>/<name>. On edit, omit it to write the result back over path.",
            ),
            json_object(
                "spec",
                MAX_ARTIFACT_SPEC_BYTES,
                "The document specification for create, in this format's spec schema. Enums and content only: no coordinates, colours, or point sizes.",
            ),
            json_array(
                "ops",
                MAX_ARTIFACT_OPS,
                MAX_ARTIFACT_OPS_BYTES,
                "Edit operations in order, each addressing ids reported by inspect. An op the file's editSurface does not allow is refused and nothing is written.",
            ),
            json_object(
                "options",
                MAX_ARTIFACT_OPTIONS_BYTES,
                "Optional switches such as {\"tracked\":true,\"author\":\"Umbratic\"} for a redlined Word edit.",
            ),
        ],
        rules: &[
            FieldRule {
                field: "spec",
                requires: &["format"],
                conflicts: &["ops"],
            },
            FieldRule {
                field: "ops",
                requires: &["path"],
                conflicts: &["spec"],
            },
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
        rules: &[],
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
        rules: &[],
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
        rules: &[],
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
        rules: &[],
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
        rules: &[],
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
        for rule in self.rules {
            if !arguments.contains_key(rule.field) {
                continue;
            }
            if let Some(missing) = rule
                .requires
                .iter()
                .find(|name| !arguments.contains_key(**name))
            {
                return Err(self.violation(
                    Some(rule.field),
                    format!("{missing} to be sent with {}", rule.field),
                ));
            }
            if let Some(present) = rule
                .conflicts
                .iter()
                .find(|name| arguments.contains_key(**name))
            {
                return Err(self.violation(
                    Some(rule.field),
                    format!("{} without {present}", rule.field),
                ));
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
        // No property list and no additionalProperties: the interior is another
        // schema's business. Declaring it here would close the object against
        // spec fields the engine understands and the runner has never heard of.
        FieldKind::JsonObject { .. } => json!({"type": "object"}),
        FieldKind::JsonArray { max_items, .. } => json!({
            "type": "array",
            "maxItems": max_items
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
        FieldKind::JsonObject { max_bytes } => {
            if !value.is_object() {
                return Err(tool.violation(Some(field.name), "a JSON object"));
            }
            bounded_json(tool, field, value, max_bytes)
        }
        FieldKind::JsonArray {
            max_items,
            max_bytes,
        } => {
            let items = value
                .as_array()
                .ok_or_else(|| tool.violation(Some(field.name), "a JSON array"))?;
            if items.len() as u64 > max_items {
                return Err(tool.violation(Some(field.name), format!("at most {max_items} items")));
            }
            bounded_json(tool, field, value, max_bytes)
        }
    }
}

/// The only bound the contract places on a nested payload. Serialized length is
/// what the transport and the worker actually pay for, so that is what is
/// measured — not a key count, which says nothing about cost.
fn bounded_json(
    tool: &ToolDefinition,
    field: &ToolField,
    value: &Value,
    max_bytes: u64,
) -> Result<(), ContractViolation> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| tool.violation(Some(field.name), "serializable JSON"))?
        .len() as u64;
    if bytes > max_bytes {
        return Err(tool.violation(
            Some(field.name),
            format!("at most {max_bytes} bytes of JSON, but received {bytes}"),
        ));
    }
    Ok(())
}
