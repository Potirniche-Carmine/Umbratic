use super::*;

/// How one dispatched call affects the warm `search` path index.
#[derive(Clone, Copy, PartialEq, Eq)]
enum IndexUpdate {
    None,
    /// A typed mutation whose result names exactly which paths changed.
    Mutation,
    /// A command can create or delete files before it fails, times out, or is
    /// aborted, so exit status says nothing about whether the tree moved.
    Coarse,
}

impl IndexUpdate {
    fn for_request(request: &ToolRequest) -> Self {
        match request {
            ToolRequest::Write(_) | ToolRequest::Edit(_) | ToolRequest::ApplyPatch(_) => {
                Self::Mutation
            }
            // An artifact create or edit puts a new file in the workspace, but
            // the result names an `out` rather than the `path` a typed
            // mutation reports, so the index is marked stale instead.
            ToolRequest::Command(_) => Self::Coarse,
            ToolRequest::Artifact(request) => {
                if request.arguments.get("action").and_then(Value::as_str) == Some("inspect") {
                    Self::None
                } else {
                    Self::Coarse
                }
            }
            _ => Self::None,
        }
    }

    fn settle(self, session: &Session, tool: &str, result: Option<&ToolResult>) {
        match self {
            Self::None => {}
            Self::Coarse => session.search_index.mark_stale(),
            Self::Mutation => {
                if let Some(result) = result {
                    note_mutation(&session.search_index, tool, result.details.as_ref());
                }
            }
        }
    }
}

fn tool_finished_event(
    session: &Session,
    call: &ToolCall,
    started_at: &str,
    started: Instant,
    result: &ToolResult,
) -> Value {
    let finished_at = now_iso();
    let mut event = json!({
        "type":"tool.finished",
        "taskId":session.task_id,
        "toolCallId":call.id,
        "exitCode":result.exit_code,
        "status":result.status,
        "startedAt":started_at,
        "finishedAt":finished_at,
        "durationMs":started.elapsed().as_secs_f64()*1000.0,
        "at":finished_at,
    });
    let fields = event.as_object_mut().expect("tool event is an object");
    // Typed payloads travel with the event so consumers never parse model-facing
    // text to learn what a tool did.
    if let Some(details) = &result.details {
        fields.insert("details".into(), details.clone());
    }
    if let Some(continuation) = &result.continuation {
        fields.insert("continuation".into(), continuation.clone());
    }
    if let Some(code) = &result.code {
        fields.insert("errorCode".into(), Value::String(code.clone()));
    }
    if let Some(message) = &result.error_message {
        let redacted = redact_text(message, 500);
        fields.insert("errorMessage".into(), Value::String(redacted.clone()));
        fields.insert("response".into(), Value::String(redacted));
    } else if result.status != "success" {
        fields.insert("response".into(), Value::String(result.content.clone()));
    }
    event
}

/// Enough to answer without a follow-up call, few enough that one evidence
/// block cannot dominate the turn. Every truncation says so.
const MAX_EVIDENCE_ITEMS: usize = 20;

/// One compact line for an LSP location, a graph node, or a graph edge. The
/// three shapes share a renderer because they share a purpose: name the thing
/// and say where it is.
fn evidence_item(item: &Value) -> String {
    let text = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or_default();
    // Graph edges: the relation and its evidence tier are the whole point.
    if !text("relation").is_empty() {
        // Node ids are long and structured; the last two segments (name and
        // line) identify the endpoint without spending the turn's budget.
        let trim = |id: &str| {
            let mut tail: Vec<&str> = id.rsplit(':').take(2).collect();
            tail.reverse();
            tail.join(":")
        };
        return format!(
            "{} {} -> {} ({})",
            text("relation"),
            trim(text("from")),
            trim(text("to")),
            text("confidence")
        );
    }
    let location = item.get("location").unwrap_or(item);
    let path = location
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let line = location
        .get("startLine")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let name = [text("label"), text("name")]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    let mut rendered = match (text("kind"), name) {
        ("", "") => String::new(),
        ("", name) => name.to_owned(),
        (kind, "") => kind.to_owned(),
        (kind, name) => format!("{kind} {name}"),
    };
    if !path.is_empty() {
        if !rendered.is_empty() {
            rendered.push_str(" — ");
        }
        rendered.push_str(path);
        if line > 0 {
            rendered.push_str(&format!(":{line}"));
        }
    }
    if let Some(score) = item.get("score").and_then(Value::as_f64) {
        rendered.push_str(&format!(" (score {score:.2})"));
    }
    if rendered.is_empty() {
        "unnamed result".to_owned()
    } else {
        rendered
    }
}

/// Renders structured evidence for the model. The typed payload stays in
/// details; this is presentation only.
fn evidence_text(evidence: &Value) -> String {
    let mut lines = Vec::new();
    if let Some(summary) = evidence.get("summary").and_then(Value::as_str) {
        lines.push(summary.to_owned());
    }
    for (label, key) in [
        ("Locations", "locations"),
        ("Nodes", "nodes"),
        ("Edges", "edges"),
    ] {
        if let Some(items) = evidence.get(key).and_then(Value::as_array)
            && !items.is_empty()
        {
            lines.push(format!("{label}: {}", items.len()));
            // The count alone is not evidence. A model told "Locations: 1" has
            // to go find the location itself, which is the tool chain these
            // tools exist to remove — so render the items, bounded.
            for item in items.iter().take(MAX_EVIDENCE_ITEMS) {
                lines.push(format!("- {}", evidence_item(item)));
            }
            if items.len() > MAX_EVIDENCE_ITEMS {
                lines.push(format!(
                    "- … {} more not shown",
                    items.len() - MAX_EVIDENCE_ITEMS
                ));
            }
        }
    }
    if let Some(markdown) = evidence.get("hoverMarkdown").and_then(Value::as_str) {
        lines.push(markdown.to_owned());
    }
    for warning in evidence
        .get("warnings")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
    {
        lines.push(format!("Warning: {warning}"));
    }
    if lines.is_empty() {
        return "No evidence was returned.".to_owned();
    }
    lines.join("\n")
}

pub async fn execute_tool(
    session: Arc<Session>,
    sink: EventSink,
    permissions: Arc<crate::permission::PermissionBroker>,
    call: ToolCall,
) -> ToolResult {
    let started_at = now_iso();
    let started = Instant::now();
    let name = redact_text(&call.name, 80);
    let surface = tool_surface(&session);
    let declared_kind = catalog::definition(&call.name).map_or("plain_text", |tool| tool.kind);
    let parsed_request = ToolRequest::parse(
        &call.name,
        &call.arguments,
        &session.config.cwd,
        surface.as_ref(),
    );
    let summary = parsed_request.as_ref().map_or_else(
        |_| format!("Invalid {name} tool request"),
        ToolRequest::summary,
    );
    let command_class = parsed_request
        .as_ref()
        .map_or("unknown", ToolRequest::command_class);
    sink.emit(json!({ "type":"tool.requested", "taskId":session.task_id, "toolCallId":call.id, "toolKind":name, "arguments":call.arguments.clone(), "commandClass":command_class, "summary":summary, "cwd":session.config.cwd, "at":started_at }));
    if session.is_aborted() {
        sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"blocked", "reason":"aborted", "at":now_iso() }));
        let result = finish_failure_pending(
            &name,
            "aborted",
            "aborted",
            "Tool call was aborted.".to_owned(),
        );
        sink.emit(tool_finished_event(
            &session,
            &call,
            &started_at,
            started,
            &result,
        ));
        return result;
    }
    let request = match parsed_request {
        Ok(value) => value,
        Err(violation) => {
            sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"blocked", "reason":"invalid_arguments", "at":now_iso() }));
            let mut result = finish_failure_pending(
                &name,
                "validation_error",
                violation.code,
                violation.message(),
            );
            result.details = Some(violation.details());
            sink.emit(tool_finished_event(
                &session,
                &call,
                &started_at,
                started,
                &result,
            ));
            return result;
        }
    };
    sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"passed", "at":now_iso() }));
    let emits_own_output = request.emits_own_output();
    let index_update = IndexUpdate::for_request(&request);
    let result: ToolExecutionResult = match request {
        ToolRequest::Read(request) => read_tool(&session, &request.arguments).await,
        ToolRequest::ReadAttachment(request) => read_attachment_tool(&session, &request.arguments),
        ToolRequest::Write(request) => {
            write_tool(&session, &sink, &request.arguments, &permissions).await
        }
        ToolRequest::Edit(request) => {
            edit_tool(&session, &sink, &request.arguments, &permissions).await
        }
        ToolRequest::ApplyPatch(request) => {
            apply_patch_tool(&session, &sink, &request.arguments, &permissions).await
        }
        ToolRequest::Ls(request) => ls_tool(&session, &request.arguments).await,
        ToolRequest::Find(request) => find_tool(&session, &request.arguments).await,
        ToolRequest::Search(request) => search_tool(session.clone(), &request.arguments).await,
        ToolRequest::WebSearch(request) => web_search_tool(&session, &request.arguments).await,
        ToolRequest::WebFetch(request) => web_fetch_tool(&request.arguments).await,
        ToolRequest::Lsp(request) => match session.lsp.as_ref() {
            // Structured evidence goes in details; content is a short rendering
            // for the model. No consumer parses the prose.
            Some(service) => service
                .query(&request.arguments, &session)
                .await
                .map(|value| {
                    ToolResult::success_detailed(
                        format!("lsp {}", request.primary),
                        evidence_text(&value),
                        Some(value),
                        None,
                    )
                })
                .map_err(ToolError::runtime),
            None => Err(ToolError::runtime(
                "Language-server support is not configured for this session.",
            )),
        },
        ToolRequest::WorkspaceGraph(request) => session
            .workspace_graph
            .as_ref()
            .map(|service| {
                let evidence = service.query(&Value::Object(request.arguments.clone()));
                ToolResult::success_detailed(
                    format!("workspace_graph {}", request.primary),
                    evidence_text(&evidence),
                    Some(evidence),
                    None,
                )
            })
            .ok_or_else(|| {
                ToolError::runtime("Workspace graph is not configured for this session.")
            }),
        ToolRequest::Artifact(request) => {
            artifact_tool(&session, &sink, &request.arguments, &permissions).await
        }
        ToolRequest::Command(request) => {
            command_tool(
                &session,
                &sink,
                request.arguments(),
                &permissions,
                &call.id,
                request.safety(),
            )
            .await
        }
        ToolRequest::ReadSkill(request) => {
            let skill_id = string_arg(&request.arguments, &["skillId"]);
            let run_id = session
                .active_run_id()
                .unwrap_or_else(|| format!("run-{}", session.id));
            match crate::skill_preflight::load_skill_with_lifecycle(
                &session, &run_id, &skill_id, "model", &sink,
            ) {
                Ok(_) => read_skill_tool(&session, &request.arguments),
                Err(failure) => Err(ToolError::validation(failure.message)),
            }
        }
        ToolRequest::RetrieveContext(request) => {
            let hash = request.primary;
            let args = request.arguments;
            let mut store = session.context_store.lock().await;
            store.retrieve(&hash, args.get("offset").and_then(Value::as_u64).map(|value| value as usize), args.get("limit").and_then(Value::as_u64).map(|value| value as usize)).map(|window| { sink.emit(json!({"type":"context.retrieved","taskId":session.task_id,"toolCallId":call.id,"hash":window.entry.hash,"offset":window.offset,"bytesShown":window.bytes_shown,"totalBytes":window.entry.original_bytes,"at":now_iso()})); let status = window.next_offset.map(|value| format!("Next offset: {value}")).unwrap_or_else(|| if window.entry.original_truncated { format!("Read status: stored copy complete; original output was capped at {} of {} bytes", window.entry.stored_bytes, window.entry.original_bytes) } else { "Read status: complete".into() }); ToolResult::success(hash.clone(), format!("Retrieved context {}\nKind: {}\nStrategy: {}\nBytes shown: {}-{} of {}\n{}\n\n{}", window.entry.hash, window.entry.kind, window.entry.strategy, window.offset, window.offset + window.bytes_shown, window.entry.original_bytes, status, window.content)) }).ok_or_else(|| {
                // retrieve_context is declared for the whole task, so an empty store
                // answers with one stable typed result instead of the tool vanishing
                // from the surface between steps.
                let empty = !store.has_entries();
                ToolError {
                    status: "validation_error",
                    code: if empty { "context_not_available" } else { "context_hash_unknown" },
                    message: if empty {
                        "No tool output has been compacted yet, so there is nothing to retrieve.".to_owned()
                    } else {
                        format!("No stored context found for hash {hash}.")
                    },
                    details: Some(json!({"hash": hash, "storeEmpty": empty})),
                }
            })
        }
    };
    index_update.settle(&session, &call.name, result.as_ref().ok());
    match result {
        Ok(mut result) => {
            if !emits_own_output && !result.content.is_empty() {
                sink.emit(json!({ "type":"tool.output", "taskId":session.task_id, "toolCallId":call.id, "stream":"stdout", "text":result.content, "redacted":true, "at":now_iso() }));
            }
            let mut store = session.context_store.lock().await;
            let compressed = compress_tool_result(
                &mut store,
                &name,
                declared_kind,
                &call.id,
                &result.summary,
                &result.content,
                &result.status,
            );
            if compressed.modified {
                sink.emit(json!({"type":"context.compressed","taskId":session.task_id,"toolCallId":call.id,"toolKind":name,"kind":compressed.kind,"strategy":compressed.strategy,"hash":compressed.marker_hash,"originalBytes":compressed.original_bytes,"outputBytes":compressed.output_bytes,"at":now_iso()}));
                result.content = compressed.output;
            }
            sink.emit(tool_finished_event(
                &session,
                &call,
                &started_at,
                started,
                &result,
            ));
            result
        }
        Err(error) => {
            let mut result = finish_failure_pending(&name, error.status, error.code, error.message);
            result.details = error.details;
            sink.emit(tool_finished_event(
                &session,
                &call,
                &started_at,
                started,
                &result,
            ));
            result
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_failure_pending(name: &str, status: &str, code: &str, message: String) -> ToolResult {
    let mut result = ToolResult::failure(status, code, message);
    result.summary = name.to_owned();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A count is not evidence. This is the regression that made the workspace
    // graph useless in its first live run: the model was told "Nodes: 11" and
    // nothing else, so it fell back to the ls-and-read chain the tool exists
    // to replace.
    #[test]
    fn evidence_text_names_the_items_rather_than_only_counting_them() {
        let rendered = evidence_text(&json!({
            "summary": "Workspace graph contains 2 nodes.",
            "nodes": [
                {"id":"symbol:src/store.ts:function:save:5","kind":"function","label":"save",
                 "location":{"path":"src/store.ts","startLine":5}},
                {"id":"file:src/store.ts","kind":"file","label":"src/store.ts",
                 "location":{"path":"src/store.ts","startLine":1}}
            ],
            "edges": [
                {"id":"e1","from":"symbol:src/ledger.ts:function:recordEntry:5",
                 "to":"symbol:src/store.ts:function:save:5","relation":"calls",
                 "confidence":"inferred","evidence":"x",
                 "source":{"path":"src/ledger.ts","startLine":6}}
            ]
        }));
        assert!(rendered.contains("function save — src/store.ts:5"));
        assert!(rendered.contains("calls recordEntry:5 -> save:5 (inferred)"));
    }

    #[test]
    fn lsp_locations_render_their_paths_and_lines() {
        let rendered = evidence_text(&json!({
            "summary": "Found 1 definitions.",
            "locations": [{"path":"src/a.ts","startLine":12,"kind":"function","name":"save"}]
        }));
        assert!(rendered.contains("function save — src/a.ts:12"));
    }

    #[test]
    fn oversized_evidence_truncates_and_says_so() {
        let nodes: Vec<Value> = (0..MAX_EVIDENCE_ITEMS + 5)
            .map(|index| {
                json!({"kind":"function","label":format!("f{index}"),
                                "location":{"path":"src/a.ts","startLine":index + 1}})
            })
            .collect();
        let rendered = evidence_text(&json!({"summary": "many", "nodes": nodes}));
        assert!(rendered.contains("… 5 more not shown"));
        assert!(!rendered.contains("f24 "));
    }

    #[test]
    fn affected_scores_appear_on_the_rendered_line() {
        let rendered = evidence_text(&json!({
            "summary": "s",
            "nodes": [{"kind":"function","label":"createUser","score":0.6,
                       "location":{"path":"src/ledger.ts","startLine":5}}]
        }));
        assert!(rendered.contains("(score 0.60)"));
    }
}
