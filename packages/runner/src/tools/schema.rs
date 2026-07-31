use super::*;

fn tool_definition(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description, "parameters": { "type": "object", "properties": properties, "required": required, "additionalProperties": false } } })
}

pub(super) fn run_program_description(approved_ids: &[String]) -> String {
    let mut guidance = vec![
        "Run one approved executable by id without shell lookup. Send exactly programId, optional args, and optional timeoutMs. Put one argument value in each args item. Do not repeat the executable name, use shell operators, or send a command field.".to_owned(),
    ];
    for id in approved_ids {
        let example = match id.as_str() {
            "uv" => Some(
                r#"For a Python script with uv, use {"programId":"uv","args":["run","python","path/to/script.py"]}; never pass the script path as uv's first argument."#,
            ),
            "python" => Some(
                r#"For a direct Python script, use {"programId":"python","args":["path/to/script.py"]}."#,
            ),
            "npm" => {
                Some(r#"For an npm script, use {"programId":"npm","args":["run","script-name"]}."#)
            }
            "git" => {
                Some(r#"For Git status, use {"programId":"git","args":["status","--short"]}."#)
            }
            "cmake" => {
                Some(r#"For CMake configuration, put each flag and value in a separate args item."#)
            }
            _ => None,
        };
        if let Some(example) = example {
            guidance.push(example.to_owned());
        }
    }
    guidance.join(" ")
}

pub async fn enabled_tool_specs(session: &Session, include_tools: bool) -> Vec<Value> {
    if !include_tools {
        return Vec::new();
    }
    let enabled = &session.config.enabled_tools;
    let mut specs = Vec::new();
    if enabled.iter().any(|name| name == "read") {
        specs.push(tool_definition(
            "read",
            "Read one exact workspace text file or list one exact workspace directory. Do not guess paths or use globs. Copy filePath from workspace context or a successful listing or search result; otherwise search or list the parent directory first. Send exactly one JSON object. Use filePath \".\" for the workspace root. Use offset and limit only to continue a partial result.",
            json!({
                "filePath":{"type":"string","minLength":1,"description":"Workspace-relative file or directory path."},
                "offset":{"type":"integer","minimum":0,"description":"Zero-based byte or entry offset reported by a prior partial result."},
                "limit":{"type":"integer","minimum":1,"description":"Maximum bytes, lines, or entries to return."},
                "depth":{"type":"integer","minimum":1,"maximum":8,"description":"Directory traversal depth. Use only for a directory listing."}
            }),
            &["filePath"],
        ));
    }
    if enabled.iter().any(|name| name == "write") {
        specs.push(tool_definition(
            "write",
            "Create or replace one workspace text file after permission. Send exactly filePath and content.",
            json!({
                "filePath":{"type":"string","minLength":1,"description":"Workspace-relative destination file."},
                "content":{"type":"string","description":"Complete UTF-8 file content."}
            }),
            &["filePath", "content"],
        ));
    }
    if enabled.iter().any(|name| name == "edit") {
        specs.push(tool_definition(
            "edit",
            "Replace one exact text block in one workspace file after permission. Send exactly filePath, oldText, and newText. Copy oldText from the latest read result. LF and CRLF match automatically.",
            json!({
                "filePath":{"type":"string","minLength":1,"description":"Workspace-relative file to edit."},
                "oldText":{"type":"string","minLength":1,"description":"Exact current text to replace."},
                "newText":{"type":"string","description":"Replacement text."}
            }),
            &["filePath", "oldText", "newText"],
        ));
        specs.push(tool_definition(
            "apply_patch",
            "Apply one exact Begin Patch document to workspace files after permission. Send exactly the patch field. Do not send edit fields.",
            json!({ "patch":{"type":"string","minLength":1,"description":"A complete *** Begin Patch through *** End Patch document."} }),
            &["patch"],
        ));
    }
    if enabled.iter().any(|name| name == "search") {
        specs.push(tool_definition(
            "search",
            "Search workspace paths and text contents without shell commands. Send one exact JSON object. Use query for one fuzzy path or multi-word content search. For a broad audit, use queries with up to 32 independent literal terms; the runner scans them together in one parallel workspace pass and reports coverage. Do not combine query and queries. Use path, glob, and exclude to scope the scan. Copy exact result paths into later tools.",
            json!({
                "query":{"type":"string","description":"Text or path terms to find. Omit to list paths in a scope."},
                "queries":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","minLength":1,"maxLength":256},"description":"Independent literal content terms for one broad scan. A line matches when it contains any term."},
                "path":{"type":"string","description":"Workspace-relative directory or file scope."},
                "glob":{"type":"string","description":"One include glob."},
                "exclude":{"type":"string","description":"One exclude glob."},
                "caseSensitive":{"type":"boolean"},
                "limit":{"type":"integer","minimum":1,"maximum":200}
            }),
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
                "line":{"type":"integer","minimum":1},
                "character":{"type":"integer","minimum":1},
                "query":{"type":"string"},
                "limit":{"type":"integer","minimum":1,"maximum":200}
            }),
            &["action"],
        ));
    }
    if enabled.iter().any(|name| name == "workspace_graph") && session.workspace_graph.is_some() {
        specs.push(tool_definition("workspace_graph", "Query bounded source-backed workspace graph evidence.", json!({ "action":{"type":"string","enum":["summary","query","explain","path","affected"]}, "query":{"type":"string"}, "symbol":{"type":"string"}, "from":{"type":"string"}, "to":{"type":"string"}, "files":{"type":"array","items":{"type":"string"}}, "symbols":{"type":"array","items":{"type":"string"}}, "depth":{"type":"integer","minimum":1}, "limit":{"type":"integer","minimum":1}, "maxDepth":{"type":"integer","minimum":1}, "direction":{"type":"string","enum":["incoming","outgoing","both"]} }), &["action"]));
    }
    if enabled.iter().any(|name| name == "command") {
        let description = if cfg!(windows) {
            "Run a local workspace command in Windows PowerShell after policy and permission checks. Prefer read and search for file inspection."
        } else {
            "Run a local workspace command in /bin/sh after policy and permission checks. Prefer read and search for file inspection."
        };
        specs.push(tool_definition(
            "command",
            &format!("{description} Send exactly command and optional timeoutMs. Do not send programId or args."),
            json!({
                "command":{"type":"string","minLength":1,"description":"One complete shell command."},
                "timeoutMs":{"type":"integer","minimum":100,"maximum":1800000}
            }),
            &["command"],
        ));
        let approved_ids = session
            .config
            .approved_executables
            .iter()
            .filter(|(_, path)| path.is_file())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        if !approved_ids.is_empty() {
            specs.push(tool_definition(
                "run_program",
                &run_program_description(&approved_ids),
                json!({
                    "programId":{"type":"string","enum":approved_ids,"description":"One exact executable id from this enum."},
                    "args":{"type":"array","items":{"type":"string","maxLength":4096},"maxItems":128,"description":"Argument values only, in process order. Do not include the executable id."},
                    "timeoutMs":{"type":"integer","minimum":100,"maximum":1800000}
                }),
                &["programId"],
            ));
        }
    }
    if !session.config.skills.is_empty() {
        specs.push(tool_definition("read_skill", "Read complete instructions for one enabled skill before applying it.", json!({ "skillId":{"type":"string","minLength":1}, "resource":{"type":"string"}, "offset":{"type":"integer","minimum":0}, "limit":{"type":"integer","minimum":1} }), &["skillId"]));
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
            json!({ "attachmentId":{"type":"string","minLength":1}, "offset":{"type":"integer","minimum":0}, "limit":{"type":"integer","minimum":1} }),
            &["attachmentId"],
        ));
    }
    if session.context_store.lock().await.has_entries() {
        specs.push(tool_definition("retrieve_context", "Retrieve a bounded window of exact compacted local tool output.", json!({ "hash":{"type":"string","minLength":1}, "offset":{"type":"integer","minimum":0}, "limit":{"type":"integer","minimum":1} }), &["hash"]));
    }
    specs
}
