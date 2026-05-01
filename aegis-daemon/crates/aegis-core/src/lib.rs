use aegis_model::{local_system_prompt, ChatStreamSink, ModelClient};
use aegis_protocol::{ChatMessage, ChatRequest, SendTaskParams, SendTaskResult};
use aegis_store::Store;
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};

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

        if let Some(call) = extract_tool_call(&response.content) {
            let result = self.execute_tool(&turn_id, &params, &call).await;
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: response.content,
            });
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: format!(
                    "Aegis tool result for {}:\n{}\nNow answer the user with the result and any next step.",
                    call.tool, result
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
    ) -> String {
        let args_json = serde_json::to_string(&call.args).unwrap_or_else(|_| "{}".to_string());
        let destructive = matches!(call.tool.as_str(), "file.write" | "git.worktree_create");
        if destructive {
            let summary =
                "approval required; destructive and tool-creation actions are not auto-run";
            let _ = self
                .store
                .record_tool_call(turn_id, &call.tool, &args_json, false, "blocked", summary)
                .await;
            return summary.to_string();
        }

        let result = match call.tool.as_str() {
            "project.search" => {
                let Some(root) = project_root(params) else {
                    return "project root is not available".to_string();
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
                    return "project root is not available".to_string();
                };
                let file = call
                    .args
                    .get("path")
                    .or_else(|| call.args.get("file"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match aegis_tools::read_text_file(&root, &PathBuf::from(file), 12_000) {
                    Ok(content) => content,
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
            _ => format!("unknown or unavailable tool: {}", call.tool),
        };

        let approved = params.permission_mode == "bypass" || params.permission_mode == "default";
        let _ = self
            .store
            .record_tool_call(
                turn_id, &call.tool, &args_json, approved, "finished", &result,
            )
            .await;
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
    let tools = "Available read tools: project.search {\"query\":\"text\"}, file.read {\"path\":\"relative/path\"}, git.status {}, git.diff {}, git.branches {}, git.worktree_list {}. To use one tool, end your answer with a single JSON object like {\"tool\":\"file.read\",\"args\":{\"path\":\"README.md\"}}. Do not ask for destructive tools unless the user explicitly requests them.";
    if params.worktree_enabled {
        format!(
            "Aegis work mode: use a git worktree for file-changing work when tools are available. Target branch: {branch}. Worktree path: {}. Tool permission mode: {}. {tools}",
            params.worktree_path.as_deref().unwrap_or("not created yet"),
            params.permission_mode
        )
    } else {
        format!(
            "Aegis work mode: normal project checkout. Target git branch context: {branch}. Tool permission mode: {}. Prefer proposing small changes and explain which files should be touched. {tools}",
            params.permission_mode
        )
    }
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
    for candidate in json_candidates(content) {
        if let Ok(call) = serde_json::from_str::<RequestedTool>(&candidate) {
            if !call.tool.trim().is_empty() {
                return Some(call);
            }
        }
    }
    None
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
