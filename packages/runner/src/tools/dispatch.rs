use super::*;

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
    if let Some(code) = &result.error_code {
        fields.insert("errorCode".into(), Value::String(code.clone()));
    }
    if let Some(message) = &result.error_message {
        let redacted = redact_text(message, 500);
        fields.insert("errorMessage".into(), Value::String(redacted.clone()));
        fields.insert("response".into(), Value::String(redacted));
    } else if result.status != "success" {
        fields.insert("response".into(), Value::String(result.output.clone()));
    }
    event
}

pub async fn execute_tool(
    session: Arc<Session>,
    sink: EventSink,
    permissions: Arc<crate::permission::PermissionBroker>,
    call: ToolCall,
) -> ToolResult {
    let started_at = now_iso();
    let started = Instant::now();
    let name = canonical_tool_name(&call.name);
    let parsed_request = ToolRequest::parse(&name, &call.arguments, &session.config.cwd);
    let summary = parsed_request
        .as_ref()
        .map_or_else(|_| name.clone(), ToolRequest::summary);
    let command_class = parsed_request
        .as_ref()
        .map_or("unknown", ToolRequest::command_class);
    sink.emit(json!({ "type":"tool.requested", "taskId":session.task_id, "toolCallId":call.id, "toolKind":name, "arguments":call.arguments.clone(), "commandClass":command_class, "summary":summary, "cwd":session.config.cwd, "at":started_at }));
    let request = match parsed_request {
        Ok(value) => value,
        Err(error) => {
            sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"blocked", "reason":"invalid_arguments", "at":now_iso() }));
            return finish_failure(
                &session,
                &sink,
                &call,
                &name,
                &started_at,
                started,
                "validation_error",
                "invalid_arguments",
                error,
            );
        }
    };
    if session.is_aborted() {
        sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"blocked", "reason":"aborted", "at":now_iso() }));
        return finish_failure(
            &session,
            &sink,
            &call,
            &name,
            &started_at,
            started,
            "aborted",
            "aborted",
            "Tool call was aborted.".into(),
        );
    }
    if !request.is_internal()
        && !session
            .config
            .enabled_tools
            .iter()
            .any(|enabled| enabled == &name)
    {
        sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"blocked", "reason":"tool_disabled", "at":now_iso() }));
        return finish_failure(
            &session,
            &sink,
            &call,
            &name,
            &started_at,
            started,
            "validation_error",
            "tool_disabled",
            format!("Tool {name} is disabled."),
        );
    }
    sink.emit(json!({ "type":"tool.policy.stage", "taskId":session.task_id, "toolCallId":call.id, "stage":"normalize_tool_call", "outcome":"passed", "at":now_iso() }));
    let result: ToolExecutionResult = match request {
        ToolRequest::Read(request) => read_tool(&session, &request.arguments).await,
        ToolRequest::ReadAttachment(request) => read_attachment_tool(&session, &request.arguments),
        ToolRequest::Write(request) => {
            write_tool(&session, &sink, &request.arguments, &permissions).await
        }
        ToolRequest::Edit(request) => {
            edit_tool(&session, &sink, &request.arguments, &permissions).await
        }
        ToolRequest::Search(request) => search_tool(&session, &request.arguments).await,
        ToolRequest::Lsp(request) => match session.lsp.as_ref() {
            Some(service) => service
                .query(&request.arguments, &session)
                .await
                .map(|value| {
                    ToolResult::success(format!("lsp {}", request.primary), value.to_string())
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
                ToolResult::success(
                    format!("workspace_graph {}", request.primary),
                    service
                        .query(&Value::Object(request.arguments.clone()))
                        .to_string(),
                )
            })
            .ok_or_else(|| {
                ToolError::runtime("Workspace graph is not configured for this session.")
            }),
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
        ToolRequest::ReadSkill(request) => read_skill_tool(&session, &request.arguments),
        ToolRequest::RetrieveContext(request) => {
            let hash = request.primary;
            let args = request.arguments;
            let mut store = session.context_store.lock().await;
            store.retrieve(&hash, args.get("offset").and_then(Value::as_u64).map(|value| value as usize), args.get("limit").and_then(Value::as_u64).map(|value| value as usize)).map(|window| { sink.emit(json!({"type":"context.retrieved","taskId":session.task_id,"toolCallId":call.id,"hash":window.entry.hash,"offset":window.offset,"bytesShown":window.bytes_shown,"totalBytes":window.entry.original_bytes,"at":now_iso()})); let status = window.next_offset.map(|value| format!("Next offset: {value}")).unwrap_or_else(|| if window.entry.original_truncated { format!("Read status: stored copy complete; original output was capped at {} of {} bytes", window.entry.stored_bytes, window.entry.original_bytes) } else { "Read status: complete".into() }); ToolResult::success(hash.clone(), format!("Retrieved context {}\nKind: {}\nStrategy: {}\nBytes shown: {}-{} of {}\n{}\n\n{}", window.entry.hash, window.entry.kind, window.entry.strategy, window.offset, window.offset + window.bytes_shown, window.entry.original_bytes, status, window.content)) }).ok_or_else(|| ToolError::validation(format!("No stored context found for hash {hash}.")))
        }
    };
    match result {
        Ok(mut result) => {
            if name != "command" && !result.output.is_empty() {
                sink.emit(json!({ "type":"tool.output", "taskId":session.task_id, "toolCallId":call.id, "stream":"stdout", "text":result.output, "redacted":true, "at":now_iso() }));
            }
            let mut store = session.context_store.lock().await;
            let compressed = compress_tool_result(
                &mut store,
                &name,
                &call.id,
                &result.title,
                &result.output,
                &result.status,
            );
            if compressed.modified {
                sink.emit(json!({"type":"context.compressed","taskId":session.task_id,"toolCallId":call.id,"toolKind":name,"kind":compressed.kind,"strategy":compressed.strategy,"hash":compressed.marker_hash,"originalBytes":compressed.original_bytes,"outputBytes":compressed.output_bytes,"at":now_iso()}));
                result.output = compressed.output;
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
        Err(error) => finish_failure(
            &session,
            &sink,
            &call,
            &name,
            &started_at,
            started,
            error.status,
            error.code,
            error.message,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_failure(
    session: &Session,
    sink: &EventSink,
    call: &ToolCall,
    name: &str,
    started_at: &str,
    started: Instant,
    status: &str,
    code: &str,
    message: String,
) -> ToolResult {
    let mut result = ToolResult::failure(status, code, message);
    result.title = name.to_owned();
    sink.emit(tool_finished_event(
        session, call, started_at, started, &result,
    ));
    result
}
