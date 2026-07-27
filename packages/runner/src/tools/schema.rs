use super::*;

fn tool_definition(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description, "parameters": { "type": "object", "properties": properties, "required": required } } })
}

pub async fn enabled_tool_specs(session: &Session, include_tools: bool) -> Vec<Value> {
    if !include_tools {
        return Vec::new();
    }
    let enabled = &session.config.enabled_tools;
    let mut specs = Vec::new();
    if enabled.iter().any(|name| name == "read") {
        specs.push(tool_definition("read", "Read a workspace file, or list a workspace directory.", json!({ "filePath": {"type":"string"}, "offset":{"type":"number"}, "limit":{"type":"number"}, "depth":{"type":"number"} }), &["filePath"]));
    }
    if enabled.iter().any(|name| name == "write") {
        specs.push(tool_definition(
            "write",
            "Write a workspace file after permission.",
            json!({ "filePath":{"type":"string"}, "content":{"type":"string"} }),
            &["filePath", "content"],
        ));
    }
    if enabled.iter().any(|name| name == "edit") {
        specs.push(tool_definition("edit", "Replace one text block in a workspace file after permission. Use filePath, oldText, and newText. LF and CRLF line endings match automatically.", json!({ "filePath":{"type":"string"}, "oldText":{"type":"string"}, "newText":{"type":"string"} }), &["filePath", "oldText", "newText"]));
        specs.push(tool_definition(
            "apply_patch",
            "Apply a Begin Patch document to one or more workspace files after permission.",
            json!({ "patch":{"type":"string"} }),
            &["patch"],
        ));
    }
    if enabled.iter().any(|name| name == "search") {
        specs.push(tool_definition(
            "search",
            "Fuzzy-search workspace file paths and small text-file contents. Use query for text or fuzzy path terms. Use path and glob to narrow or list files. Results include line snippets that can be copied into read or edit.",
            json!({ "query":{"type":"string"}, "path":{"type":"string"}, "glob":{"type":"string"}, "exclude":{"type":"string"}, "caseSensitive":{"type":"boolean"}, "limit":{"type":"number"} }),
            &[],
        ));
    }
    if enabled.iter().any(|name| name == "lsp") && session.lsp.is_some() {
        specs.push(tool_definition(
            "lsp",
            "Query read-only language-server evidence. Use one-based line and character positions. Verify returned locations with read before an edit.",
            json!({
                "action":{"type":"string","enum":["definition","references","hover","symbols"]},
                "filePath":{"type":"string"},
                "line":{"type":"number"},
                "character":{"type":"number"},
                "query":{"type":"string"},
                "limit":{"type":"number"}
            }),
            &["action"],
        ));
    }
    if enabled.iter().any(|name| name == "workspace_graph") && session.workspace_graph.is_some() {
        specs.push(tool_definition("workspace_graph", "Query bounded source-backed workspace graph evidence.", json!({ "action":{"type":"string","enum":["summary","query","explain","path","affected"]}, "query":{"type":"string"}, "symbol":{"type":"string"}, "from":{"type":"string"}, "to":{"type":"string"}, "files":{"type":"array","items":{"type":"string"}}, "symbols":{"type":"array","items":{"type":"string"}}, "depth":{"type":"number"}, "limit":{"type":"number"}, "maxDepth":{"type":"number"}, "direction":{"type":"string","enum":["incoming","outgoing","both"]} }), &["action"]));
    }
    if enabled.iter().any(|name| name == "command") {
        let mut description = if cfg!(windows) {
            "Run a local workspace command in Windows PowerShell after policy and permission checks. Prefer read and search for file inspection."
        } else {
            "Run a local workspace command in /bin/sh after policy and permission checks. Prefer read and search for file inspection."
        }
        .to_owned();
        let approved_ids = session
            .config
            .approved_executables
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let has_approved_executables = !approved_ids.is_empty();
        if has_approved_executables {
            description.push_str(
                " For an approved executable, use programId and args. This runs the exact verified executable without shell lookup.",
            );
        }
        let required: &[&str] = if has_approved_executables {
            &[]
        } else {
            &["command"]
        };
        let mut command_spec = tool_definition(
            "command",
            &description,
            json!({
                "command":{"type":"string"},
                "programId":{"type":"string","enum":approved_ids},
                "args":{"type":"array","items":{"type":"string"},"maxItems":128},
                "timeoutMs":{"type":"number"}
            }),
            required,
        );
        if has_approved_executables {
            command_spec["function"]["parameters"]["anyOf"] =
                json!([{"required":["command"]}, {"required":["programId"]}]);
        }
        specs.push(command_spec);
    }
    if !session.config.skills.is_empty() {
        specs.push(tool_definition("read_skill", "Read complete instructions for one enabled skill before applying it.", json!({ "skillId":{"type":"string"}, "resource":{"type":"string"}, "offset":{"type":"number"}, "limit":{"type":"number"} }), &["skillId"]));
    }
    if session
        .config
        .attachment_directory
        .as_ref()
        .is_some_and(|directory| directory.is_dir())
    {
        specs.push(tool_definition(
            "read_attachment",
            "Read a bounded byte range from a complete text attachment in the current chat. For whole-document work, continue from each reported offset until Read status is complete.",
            json!({ "attachmentId":{"type":"string"}, "offset":{"type":"number"}, "limit":{"type":"number"} }),
            &["attachmentId"],
        ));
    }
    if session.context_store.lock().await.has_entries() {
        specs.push(tool_definition("retrieve_context", "Retrieve a bounded window of exact compacted local tool output.", json!({ "hash":{"type":"string"}, "offset":{"type":"number"}, "limit":{"type":"number"} }), &["hash"]));
    }
    specs
}
