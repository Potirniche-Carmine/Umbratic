use aegis_model::{local_system_prompt, ChatStreamEvent, ChatStreamSink, ModelClient};
use aegis_protocol::{
    ChatMessage, ChatRequest, ContextUsageResult, SendTaskParams, SendTaskResult,
};
use aegis_store::Store;
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};

const MAX_TOOL_ROUNDS: usize = 12;
const APPROVAL_REQUIRED_PREFIX: &str = "AEGIS_APPROVAL_REQUIRED:";

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

        let mut messages = task_messages(&params);

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

        let mut last_tool_fallback_response: Option<String> = None;
        let mut executed_tool_count = 0usize;
        let mut repaired_missing_write_tool = false;

        for _ in 0..MAX_TOOL_ROUNDS {
            let Some(mut call) = extract_tool_call(&response.content) else {
                if !repaired_missing_write_tool
                    && should_repair_missing_write_tool(&params, &response.content, executed_tool_count)
                {
                    repaired_missing_write_tool = true;
                    messages.push(ChatMessage {
                        role: "assistant".to_string(),
                        content: response.content.clone(),
                    });
                    messages.push(ChatMessage {
                        role: "user".to_string(),
                        content: "No file-changing tool has run yet. If the task requires creating or modifying files, output exactly one file.write tool call now and no prose. Do not claim files were written until a file.write observation is returned.".to_string(),
                    });
                    response = match self
                        .chat_with_optional_stream(
                            ChatRequest {
                                model: params.model.clone(),
                                messages: messages.clone(),
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
                    continue;
                }
                break;
            };
            normalize_tool_call(&mut call);
            let result = self
                .execute_tool(&turn_id, &params, &call, stream_sink.clone())
                .await;
            if let Some(message) = result.strip_prefix(APPROVAL_REQUIRED_PREFIX) {
                response.content = message.trim().to_string();
                break;
            }
            executed_tool_count += 1;
            last_tool_fallback_response = Some(tool_result_fallback(&call.tool, &result));
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: response.content,
            });
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "<tool_response name=\"{}\">\n{}\n</tool_response>\n\nUse this background observation to continue my original request. If you have enough context, answer normally now. Do not say you merely ran or read a tool; give the requested result.",
                    call.tool, result
                ),
            });
            response = match self
                .chat_with_optional_stream(
                    ChatRequest {
                        model: params.model.clone(),
                        messages: messages.clone(),
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

        if extract_tool_call(&response.content).is_some() {
            response.content = "I hit the tool-call limit while gathering context. Please send the request again and I can continue from the latest project state.".to_string();
        } else if response.content.trim().is_empty() {
            if let Some(fallback) = last_tool_fallback_response {
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

    pub async fn context_usage(&self, params: SendTaskParams) -> Result<ContextUsageResult> {
        self.model
            .count_chat_tokens(ChatRequest {
                model: params.model.clone(),
                messages: task_messages(&params),
            })
            .await
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

        if approval_required(params, call) {
            let summary = approval_request(call);
            let _ = self
                .store
                .record_tool_call(turn_id, &call.tool, &args_json, false, "approval_required", &summary)
                .await;
            emit_tool_event(
                &stream_sink,
                "tool.end",
                &call.tool,
                &call.args,
                false,
                &summary,
            );
            return format!("{APPROVAL_REQUIRED_PREFIX} {summary}");
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
                let content = normalize_file_write_content(content);
                let create_dirs = call
                    .args
                    .get("create_dirs")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                match aegis_tools::write_text_file(
                    &root,
                    &PathBuf::from(file),
                    &content,
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
            "os.context" => format!(
                "Harness operating system: {}. Project root: {}.",
                params.operating_system,
                project_root(params)
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "not available".to_string())
            ),
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

fn task_messages(params: &SendTaskParams) -> Vec<ChatMessage> {
    let mut messages = vec![
        local_system_prompt(),
        ChatMessage {
            role: "system".to_string(),
            content: work_context(params),
        },
    ];
    messages.extend(compact_history(&params.conversation_history));
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: params.message.clone(),
    });
    messages
}

fn work_context(params: &SendTaskParams) -> String {
    let branch = params.git_branch.as_deref().unwrap_or("unknown");
    let tools = tool_prompt(params);
    let attachments = attachment_prompt(params);
    let permission_note = permission_prompt(params);
    if params.worktree_enabled {
        format!(
            "Aegis work mode: use a git worktree for file-changing work when tools are available. Target branch: {branch}. Worktree path: {}. Tool permission mode: {}. Harness operating system: {}. {permission_note} {tools} {attachments}",
            params.worktree_path.as_deref().unwrap_or("not created yet"),
            params.permission_mode,
            params.operating_system
        )
    } else {
        format!(
            "Aegis work mode: normal project checkout. Target git branch context: {branch}. Tool permission mode: {}. Harness operating system: {}. Prefer small, reviewable changes. {permission_note} {tools} {attachments}",
            params.permission_mode,
            params.operating_system
        )
    }
}

fn permission_prompt(params: &SendTaskParams) -> &'static str {
    if params.permission_mode == "default" {
        "Default permissions: read/search/git inspection tools may run automatically. Before file.write or terminal.run, ask for explicit user approval. A file.write approval covers file writes for this chat; terminal.run approvals are exact to the command."
    } else {
        "Bypass permissions: tool execution may proceed, but destructive or broad commands still require care."
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
        "Enabled tools: {}. To use a tool, output only exactly one JSON object like {{\"tool\":\"file.read\",\"args\":{{\"path\":\"README.md\"}}}} and no prose. For file.write, content must be the raw file text inside the JSON string; do not wrap the whole file in extra quotes and do not include markdown fences. The harness executes approved tools in the background and sends the observation back so you can continue the original task. You may use multiple tool rounds to read, inspect, write, run, and then verify. After file.write observations, do not repeat full file contents unless explicitly asked; summarize changed files and next steps. Put terminal commands for the user in fenced code blocks. In default permission mode, file.write and terminal.run will be paused until the user explicitly approves. If the user mentions @file, omit the @ in tool args. All file paths must stay inside the project root.",
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

fn compact_history(history: &[ChatMessage]) -> Vec<ChatMessage> {
    history
        .iter()
        .filter_map(|message| {
            let role = match message.role.as_str() {
                "user" | "assistant" => message.role.clone(),
                _ => return None,
            };
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            Some(ChatMessage {
                role,
                content: content.chars().take(4_000).collect(),
            })
        })
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn should_repair_missing_write_tool(
    params: &SendTaskParams,
    response: &str,
    executed_tool_count: usize,
) -> bool {
    if executed_tool_count > 0 || !tool_enabled(params, "file.write") {
        return false;
    }

    let latest = params.message.to_lowercase();
    let response = response.to_lowercase();
    let task_is_write_like = [
        "write",
        "create",
        "generate",
        "make",
        "modify",
        "main.c",
        "cmakelists",
        "cmake",
    ]
    .iter()
    .any(|needle| latest.contains(needle));
    let latest_is_approval = latest_message_approves(&params.message);
    let response_is_false_write_or_approval = [
        "i have written",
        "i wrote",
        "i created",
        "created both",
        "have created",
        "would you like me to write",
        "please approve",
        "let me know if you approve",
        "need your approval",
    ]
    .iter()
    .any(|needle| response.contains(needle));

    (task_is_write_like || latest_is_approval) && response_is_false_write_or_approval
}

fn approval_required(params: &SendTaskParams, call: &RequestedTool) -> bool {
    if params.permission_mode != "default" {
        return false;
    }
    if !matches!(call.tool.as_str(), "file.write" | "terminal.run") {
        return false;
    }
    let action_key = tool_action_key(&call.tool, &call.args);
    if params.approved_tool_actions.iter().any(|key| key == &action_key) {
        return false;
    }
    !latest_message_approves(&params.message)
}

fn latest_message_approves(message: &str) -> bool {
    let lower = message.to_lowercase();
    let approval_words = [
        "approve",
        "approved",
        "yes",
        "yep",
        "go ahead",
        "proceed",
        "you can run",
        "permission granted",
    ];
    approval_words.iter().any(|word| lower.contains(word))
}

fn approval_request(call: &RequestedTool) -> String {
    match call.tool.as_str() {
        "terminal.run" => {
            let command = call
                .args
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if command.is_empty() {
                "I need your approval before running a terminal command. Reply with approval and the command you want me to run.".to_string()
            } else {
                format!("I need your approval before running this command:\n\n`{command}`\n\nReply with approval if you want me to run it.")
            }
        }
        "file.write" => {
            let file = call
                .args
                .get("path")
                .or_else(|| call.args.get("file"))
                .and_then(Value::as_str)
                .unwrap_or("the requested file");
            format!("I need your approval before writing `{file}`. Reply with approval if you want me to create or modify it.")
        }
        _ => "I need your approval before running that tool.".to_string(),
    }
}

fn tool_action_key(tool: &str, args: &Value) -> String {
    if tool == "file.write" {
        return "file.write".to_string();
    }
    format!("{tool}:{}", canonical_json(args))
}

fn canonical_json(value: &Value) -> String {
    serde_json::to_string(&canonical_value(value)).unwrap_or_else(|_| "{}".to_string())
}

fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_value).collect()),
        Value::Object(map) => {
            let mut sorted = Map::new();
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(value) = map.get(key) {
                    sorted.insert(key.clone(), canonical_value(value));
                }
            }
            Value::Object(sorted)
        }
        other => other.clone(),
    }
}

fn tool_action_command(tool: &str, args: &Value) -> String {
    if tool == "terminal.run" {
        return args
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
    }
    if tool == "file.write" {
        let file = args
            .get("path")
            .or_else(|| args.get("file"))
            .and_then(Value::as_str)
            .unwrap_or("file");
        return format!("Write {file}");
    }
    json!({
        "tool": tool,
        "args": canonical_value(args),
    })
    .to_string()
}

fn tool_result_fallback(tool: &str, result: &str) -> String {
    let trimmed = result.trim();
    let note = if trimmed.is_empty() {
        "The tool completed, but returned no text."
    } else {
        "The tool completed and returned context."
    };
    format!("I used {tool} for context, but the model did not produce a final answer after the observation. {note}")
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
        .trim_end_matches(|c| matches!(c, '}' | ')' | ']' | '"' | '`'))
        .trim_start_matches('@')
        .replace('\\', "/")
}

fn normalize_file_write_content(content: &str) -> String {
    let mut text = content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\"", "\"")
        .replace("\\'", "'");

    let trimmed = text.trim();
    if trimmed.starts_with("```") && trimmed.ends_with("```") {
        let mut lines = trimmed.lines().collect::<Vec<_>>();
        if lines.len() >= 2 {
            lines.remove(0);
            lines.pop();
            text = lines.join("\n");
        }
    }

    let original_trimmed = content.trim();
    let had_escaped_wrapper = original_trimmed.starts_with("\\\"") || original_trimmed.starts_with("\\'");
    if had_escaped_wrapper {
        text = text.trim_start_matches(['"', '\'']).to_string();
        if let Some((first, rest)) = text.split_once('\n') {
            let quote_count = first.chars().filter(|character| *character == '"').count();
            if quote_count == 1 && first.ends_with('"') {
                text = format!("{}\n{rest}", first.trim_end_matches('"'));
            }
        }
    }

    if had_escaped_wrapper {
        while text.ends_with('\\') || text.ends_with('"') || text.ends_with('\'') {
            text.pop();
        }
    } else if text.ends_with('\\') && content.trim_end().ends_with('\\') {
        text.pop();
    }

    text
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
        let approval_required = summary.starts_with("I need your approval before");
        sink(ChatStreamEvent {
            kind: kind.to_string(),
            content: None,
            data: json!({
                "tool": tool,
                "args": args,
                "success": success,
                "approval_required": approval_required,
                "action_key": tool_action_key(tool, args),
                "command": tool_action_command(tool, args),
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
