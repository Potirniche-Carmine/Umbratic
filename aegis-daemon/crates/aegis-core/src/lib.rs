use aegis_model::{local_system_prompt, ChatStreamEvent, ChatStreamSink, ModelClient};
use aegis_protocol::{ChatMessage, ChatRequest, SendTaskParams, SendTaskResult};
use aegis_store::Store;
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};

const AGENT_RESPONSE_FOOTER_INSTRUCTION: &str = "At the end of every final response, include a compact review note with two short sections: Files changed and Verified. Use short sentences. If no files changed, say none. If nothing was verified, say not verified.";

#[derive(Clone)]
pub struct AegisCore {
    store: Store,
    model: Arc<dyn ModelClient>,
}

impl AegisCore {
    pub fn new(store: Store, model: Arc<dyn ModelClient>) -> Self {
        Self { store, model }
    }

    pub async fn send_task(
        &self,
        params: SendTaskParams,
        stream_sink: Option<ChatStreamSink>,
    ) -> Result<SendTaskResult> {
        let title = params
            .message
            .lines()
            .next()
            .unwrap_or("Local task")
            .chars()
            .take(80)
            .collect::<String>();
        let session_id = self
            .store
            .create_session(params.project_id.as_deref(), &params.model, &title)
            .await
            .context("failed to create session")?;

        let prompt_fingerprint = fingerprint(&params.message);
        let turn_id = self
            .store
            .create_turn(&session_id, &params.message, &prompt_fingerprint)
            .await
            .context("failed to create turn")?;

        let mut messages = vec![
            local_system_prompt(),
            ChatMessage {
                role: "system".to_string(),
                content: work_context(&params),
            },
            ChatMessage {
                role: "user".to_string(),
                content: params.message.clone(),
            },
        ];

        let chat = ChatRequest {
            model: params.model.clone(),
            messages: messages.clone(),
        };

        let mut response = match self
            .chat_with_optional_stream(chat, stream_sink.clone())
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.store.finish_turn(&turn_id, "failed").await?;
                self.store.finish_session(&session_id, "failed").await?;
                return Err(error);
            }
        };

        let mut tool_fallback_response: Option<String> = None;

        if let Some(mut call) = extract_tool_call(&response.content) {
            normalize_tool_call(&mut call);
            let result = self
                .execute_tool(&turn_id, &params, &call, stream_sink.clone())
                .await;
            tool_fallback_response = Some(tool_result_fallback(&call.tool, &result));
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: response.content,
            });
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: format!(
                    "Aegis tool result for {}:\n{}\nNow answer the user with the result and any next step.\n{}",
                    call.tool, result, AGENT_RESPONSE_FOOTER_INSTRUCTION
                ),
            });
            response = match self
                .chat_with_optional_stream(
                    ChatRequest {
                        model: params.model.clone(),
                        messages,
                    },
                    stream_sink.clone(),
                )
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    self.store.finish_turn(&turn_id, "failed").await?;
                    self.store.finish_session(&session_id, "failed").await?;
                    return Err(error);
                }
            };
        }

        if response.content.trim().is_empty() {
            if let Some(fallback) = tool_fallback_response {
                response.content = fallback;
            }
        }

        self.store.finish_turn(&turn_id, "finished").await?;
        self.store.finish_session(&session_id, "finished").await?;

        Ok(SendTaskResult {
            session_id,
            turn_id,
            assistant_message: response.content,
        })
    }

    async fn chat_with_optional_stream(
        &self,
        chat: ChatRequest,
        stream_sink: Option<ChatStreamSink>,
    ) -> Result<aegis_protocol::ChatResponse> {
        if let Some(sink) = stream_sink {
            match self.model.chat_stream(chat.clone(), sink).await {
                Ok(response) => return Ok(response),
                Err(_) => {}
            }
        }
        self.model.chat(chat).await
    }

    async fn execute_tool(
        &self,
        turn_id: &str,
        params: &SendTaskParams,
        call: &RequestedTool,
        stream_sink: Option<ChatStreamSink>,
    ) -> String {
        let args_json = serde_json::to_string(&call.args).unwrap_or_else(|_| "{}".to_string());
        emit_tool_event(&stream_sink, "tool.start", &call.tool, &call.args, true, "");

        if !tool_enabled(params, &call.tool) {
            let summary = format!("{} is disabled for this chat", call.tool);
            let _ = self
                .store
                .record_tool_call(turn_id, &call.tool, &args_json, false, "blocked", &summary)
                .await;
            emit_tool_event(
                &stream_sink,
                "tool.end",
                &call.tool,
                &call.args,
                false,
                &summary,
            );
            return summary;
        }

        let result = match call.tool.as_str() {
            "project.search" | "rg.search" | "grep.search" => {
                let Some(root) = project_root(params) else {
                    return finish_tool(
                        &self.store,
                        turn_id,
                        &call.tool,
                        &args_json,
                        &stream_sink,
                        &call.args,
                        false,
                        "project root is not available".to_string(),
                    )
                    .await;
                };
                let query = call
                    .args
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match aegis_tools::lexical_search(&root, query, 20) {
                    Ok(matches) => json!(matches).to_string(),
                    Err(error) => error.to_string(),
                }
            }
            "file.read" => {
                let Some(root) = project_root(params) else {
                    return finish_tool(
                        &self.store,
                        turn_id,
                        &call.tool,
                        &args_json,
                        &stream_sink,
                        &call.args,
                        false,
                        "project root is not available".to_string(),
                    )
                    .await;
                };
                let file = call
                    .args
                    .get("path")
                    .or_else(|| call.args.get("file"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match aegis_tools::read_text_file(&root, &PathBuf::from(file), 12_000) {
                    Ok(content) => content,
                    Err(error) => {
                        match aegis_tools::resolve_project_file_reference(&root, file, 10_000) {
                            Ok(Some(resolved)) => {
                                match aegis_tools::read_text_file(&root, &resolved, 12_000) {
                                    Ok(content) => content,
                                    Err(second_error) => second_error.to_string(),
                                }
                            }
                            Ok(None) => error.to_string(),
                            Err(_) => error.to_string(),
                        }
                    }
                }
            }
            "file.write" => {
                let Some(root) = project_root(params) else {
                    return finish_tool(
                        &self.store,
                        turn_id,
                        &call.tool,
                        &args_json,
                        &stream_sink,
                        &call.args,
                        false,
                        "project root is not available".to_string(),
                    )
                    .await;
                };
                let file = call
                    .args
                    .get("path")
                    .or_else(|| call.args.get("file"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let content = call
                    .args
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let create_dirs = call
                    .args
                    .get("create_dirs")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                match aegis_tools::write_text_file(
                    &root,
                    &PathBuf::from(file),
                    content,
                    create_dirs,
                ) {
                    Ok(summary) => summary,
                    Err(error) => error.to_string(),
                }
            }
            "git.status" => match project_root(params) {
                Some(root) => match aegis_tools::git_status(&root).await {
                    Ok(status) => status.stdout + &status.stderr,
                    Err(error) => error.to_string(),
                },
                None => "project root is not available".to_string(),
            },
            "git.diff" => match project_root(params) {
                Some(root) => match aegis_tools::git_diff(&root).await {
                    Ok(status) => status.stdout + &status.stderr,
                    Err(error) => error.to_string(),
                },
                None => "project root is not available".to_string(),
            },
            "git.branches" => match project_root(params) {
                Some(root) => match aegis_tools::git_branches(&root).await {
                    Ok(branches) => json!(branches).to_string(),
                    Err(error) => error.to_string(),
                },
                None => "project root is not available".to_string(),
            },
            "git.worktree_list" => match project_root(params) {
                Some(root) => match aegis_tools::git_worktrees(&root).await {
                    Ok(worktrees) => json!(worktrees).to_string(),
                    Err(error) => error.to_string(),
                },
                None => "project root is not available".to_string(),
            },
            "terminal.run" => {
                let Some(root) = project_root(params) else {
                    return finish_tool(
                        &self.store,
                        turn_id,
                        &call.tool,
                        &args_json,
                        &stream_sink,
                        &call.args,
                        false,
                        "project root is not available".to_string(),
                    )
                    .await;
                };
                let command = call
                    .args
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match aegis_tools::run_terminal_command(&root, command).await {
                    Ok(output) => {
                        let text = format!("$ {command}\n{}{}", output.stdout, output.stderr);
                        emit_terminal_output(&stream_sink, &text);
                        text
                    }
                    Err(error) => error.to_string(),
                }
            }
            _ => format!("unknown or unavailable tool: {}", call.tool),
        };

        let approved = params.permission_mode == "bypass" || params.permission_mode == "default";
        let _ = self
            .store
            .record_tool_call(
                turn_id, &call.tool, &args_json, approved, "finished", &result,
            )
            .await;
        emit_tool_event(
            &stream_sink,
            "tool.end",
            &call.tool,
            &call.args,
            true,
            &result,
        );
        result
    }
}

fn fingerprint(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn work_context(params: &SendTaskParams) -> String {
    let branch = params.git_branch.as_deref().unwrap_or("unknown");
    let tools = tool_prompt(params);
    let attachments = attachment_prompt(params);
    if params.worktree_enabled {
        format!(
            "Aegis work mode: use a git worktree for file-changing work when tools are available. Target branch: {branch}. Worktree path: {}. Tool permission mode: {}. Harness operating system: {}. {tools} {attachments} {}",
            params.worktree_path.as_deref().unwrap_or("not created yet"),
            params.permission_mode,
            params.operating_system,
            AGENT_RESPONSE_FOOTER_INSTRUCTION,
        )
    } else {
        format!(
            "Aegis work mode: normal project checkout. Target git branch context: {branch}. Tool permission mode: {}. Harness operating system: {}. Prefer small, reviewable changes. {tools} {attachments} {}",
            params.permission_mode,
            params.operating_system,
            AGENT_RESPONSE_FOOTER_INSTRUCTION,
        )
    }
}

fn attachment_prompt(params: &SendTaskParams) -> String {
    if params.attached_files.is_empty() {
        return "Attached files: none.".to_string();
    }
    let mut rows = Vec::new();
    for file in &params.attached_files {
        let path = file
            .project_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .unwrap_or(&file.path);
        let mut row = format!("@{path}");
        if let Some(content) = file
            .content
            .as_deref()
            .filter(|content| !content.is_empty())
        {
            row.push_str("\nAttached content preview:\n");
            row.push_str(content);
        } else if file.project_path.is_some() {
            row.push_str(
                " (project file mention; use file.read with this relative path and omit the @)",
            );
        }
        rows.push(row);
    }
    format!("Attached files:\n{}", rows.join("\n---\n"))
}

fn tool_prompt(params: &SendTaskParams) -> String {
    let mut enabled = params.enabled_tools.clone();
    if enabled.is_empty() {
        enabled = default_enabled_tools();
    }
    let mut descriptions: Vec<String> = Vec::new();
    for tool in params
        .tool_context
        .iter()
        .filter(|tool| tool.enabled && enabled.iter().any(|id| id == &tool.id))
    {
        let mut row = tool.id.clone();
        if !tool.command.trim().is_empty() {
            row.push_str(" ");
            row.push_str(tool.command.trim());
        }
        if !tool.summary.trim().is_empty() {
            row.push_str(" - ");
            row.push_str(tool.summary.trim());
        }
        descriptions.push(row);
    }
    if descriptions.is_empty() {
        for tool in &enabled {
            match tool.as_str() {
                "project.search" => descriptions.push("project.search {\"query\":\"text\"}".to_string()),
                "rg.search" => descriptions.push("rg.search {\"query\":\"text\"}".to_string()),
                "grep.search" => descriptions.push("grep.search {\"query\":\"text\"}".to_string()),
                "file.read" => descriptions.push("file.read {\"path\":\"relative/path\"}".to_string()),
                "file.write" => descriptions.push("file.write {\"path\":\"relative/path\",\"content\":\"text\",\"create_dirs\":true}".to_string()),
                "git.status" => descriptions.push("git.status {}".to_string()),
                "git.diff" => descriptions.push("git.diff {}".to_string()),
                "git.branches" => descriptions.push("git.branches {}".to_string()),
            "git.worktree_list" => descriptions.push("git.worktree_list {}".to_string()),
                "terminal.run" => descriptions.push("terminal.run {\"command\":\"pwd\"}".to_string()),
                _ => {}
            }
        }
    }
    format!(
        "Enabled tools: {}. To use one tool, end your answer with exactly one JSON object like {{\"tool\":\"file.read\",\"args\":{{\"path\":\"README.md\"}}}}. If the user mentions @file, omit the @ in tool args. All file paths must stay inside the project root.",
        descriptions.join(", ")
    )
}

fn default_enabled_tools() -> Vec<String> {
    [
        "project.search",
        "rg.search",
        "grep.search",
        "file.read",
        "file.write",
        "git.status",
        "git.diff",
        "git.branches",
        "git.worktree_list",
        "terminal.run",
        "os.context",
    ]
    .into_iter()
    .map(ToOwned::to_owned)
    .collect()
}

fn tool_result_fallback(tool: &str, result: &str) -> String {
    let trimmed = result.trim();
    let body = if trimmed.is_empty() {
        "The tool completed, but returned no text.".to_string()
    } else {
        trimmed.chars().take(2_400).collect()
    };
    format!(
        "I ran {tool} and got:\n\n{body}\n\nFiles changed: none.\nVerified: tool result returned."
    )
}

fn tool_enabled(params: &SendTaskParams, tool: &str) -> bool {
    let enabled = if params.enabled_tools.is_empty() {
        default_enabled_tools()
    } else {
        params.enabled_tools.clone()
    };
    if enabled.iter().any(|item| item == tool) {
        return true;
    }
    matches!(
        (tool, enabled.iter().any(|item| item == "project.search")),
        ("rg.search" | "grep.search", true)
    )
}

fn normalize_tool_call(call: &mut RequestedTool) {
    if matches!(call.tool.as_str(), "file.read" | "file.write") {
        normalize_path_arg(&mut call.args, "path");
        normalize_path_arg(&mut call.args, "file");
    }
}

fn normalize_path_arg(args: &mut Value, key: &str) {
    let Some(path) = args.get(key).and_then(Value::as_str) else {
        return;
    };
    let normalized = normalize_tool_path(path);
    if normalized != path {
        if let Some(object) = args.as_object_mut() {
            object.insert(key.to_string(), Value::String(normalized));
        }
    }
}

fn normalize_tool_path(path: &str) -> String {
    path.trim()
        .trim_matches('`')
        .trim_matches('"')
        .trim_start_matches('@')
        .replace('\\', "/")
}

fn emit_tool_event(
    stream_sink: &Option<ChatStreamSink>,
    kind: &str,
    tool: &str,
    args: &Value,
    success: bool,
    summary: &str,
) {
    if let Some(sink) = stream_sink {
        sink(ChatStreamEvent {
            kind: kind.to_string(),
            content: None,
            data: json!({
                "tool": tool,
                "args": args,
                "success": success,
                "summary": summary.chars().take(240).collect::<String>(),
            }),
        });
    }
}

fn emit_terminal_output(stream_sink: &Option<ChatStreamSink>, content: &str) {
    if let Some(sink) = stream_sink {
        sink(ChatStreamEvent {
            kind: "terminal.output".to_string(),
            content: Some(content.to_string()),
            data: json!({}),
        });
    }
}

async fn finish_tool(
    store: &Store,
    turn_id: &str,
    tool: &str,
    args_json: &str,
    stream_sink: &Option<ChatStreamSink>,
    args: &Value,
    success: bool,
    result: String,
) -> String {
    let _ = store
        .record_tool_call(
            turn_id,
            tool,
            args_json,
            false,
            if success { "finished" } else { "failed" },
            &result,
        )
        .await;
    emit_tool_event(stream_sink, "tool.end", tool, args, success, &result);
    result
}

#[derive(Debug, Deserialize)]
struct RequestedTool {
    tool: String,
    #[serde(default)]
    args: Value,
}

fn project_root(params: &SendTaskParams) -> Option<PathBuf> {
    params
        .worktree_path
        .as_deref()
        .or(params.project_root.as_deref())
        .map(PathBuf::from)
}

fn extract_tool_call(content: &str) -> Option<RequestedTool> {
    if let Some(call) = tagged_tool_call(content) {
        return Some(call);
    }
    for candidate in json_candidates(content) {
        if let Ok(call) = serde_json::from_str::<RequestedTool>(&candidate) {
            if !call.tool.trim().is_empty() {
                return Some(call);
            }
        }
    }
    None
}

fn tagged_tool_call(content: &str) -> Option<RequestedTool> {
    let start = content.find("<|tool_call>")?;
    let rest = &content[start + "<|tool_call>".len()..];
    let end = rest.find("<tool_call|>")?;
    let body = rest[..end].trim();
    let body = body.strip_prefix("call:").unwrap_or(body);
    let json_start = body.find('{')?;
    let tool = body[..json_start].trim().to_string();
    let args = parse_tool_args(&body[json_start..])?;
    if tool.is_empty() {
        return None;
    }
    Some(RequestedTool { tool, args })
}

fn parse_tool_args(input: &str) -> Option<Value> {
    let normalized = input.replace("<|\"|>", "\"").replace("<|'|>", "'");
    if let Ok(value) = serde_json::from_str::<Value>(&normalized) {
        return Some(value);
    }
    parse_loose_object(&normalized)
}

fn parse_loose_object(input: &str) -> Option<Value> {
    let body = input.trim().strip_prefix('{')?.strip_suffix('}')?;
    let mut map = serde_json::Map::new();
    for part in body.split(',') {
        let (key, value) = part.split_once(':')?;
        let key = key.trim().trim_matches('"').trim_matches('\'');
        if key.is_empty() {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
    Some(Value::Object(map))
}

fn json_candidates(content: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(start) = content.find("```json") {
        let rest = &content[start + 7..];
        if let Some(end) = rest.find("```") {
            candidates.push(rest[..end].trim().to_string());
        }
    }
    if let (Some(start), Some(end)) = (content.find('{'), content.rfind('}')) {
        if end > start {
            candidates.push(content[start..=end].trim().to_string());
        }
    }
    candidates
}
