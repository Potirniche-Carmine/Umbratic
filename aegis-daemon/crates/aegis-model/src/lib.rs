use aegis_protocol::{ChatMessage, ChatRequest, ChatResponse, ContextUsageResult, ModelInfo};
use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct ChatStreamEvent {
    pub kind: String,
    pub content: Option<String>,
    pub data: Value,
}

pub type ChatStreamSink = Arc<dyn Fn(ChatStreamEvent) + Send + Sync>;

#[async_trait]
pub trait ModelClient: Send + Sync {
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse>;
    async fn chat_stream(&self, request: ChatRequest, sink: ChatStreamSink)
        -> Result<ChatResponse>;
    async fn count_chat_tokens(&self, request: ChatRequest) -> Result<ContextUsageResult>;
    async fn embed(&self, input: Vec<String>) -> Result<Vec<Vec<f32>>>;
    async fn list_models(&self) -> Result<Vec<ModelInfo>>;
}

#[derive(Clone)]
pub struct LmStudioClient {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
}

impl LmStudioClient {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            http: reqwest::Client::new(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path.trim_start_matches('/'))
    }

    fn rest_url(&self, path: &str) -> String {
        let root = self
            .base_url
            .strip_suffix("/v1")
            .unwrap_or(&self.base_url)
            .trim_end_matches('/');
        format!("{}/{}", root, path.trim_start_matches('/'))
    }
}

#[async_trait]
impl ModelClient for LmStudioClient {
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        let response = self
            .http
            .post(self.url("/chat/completions"))
            .bearer_auth(&self.api_key)
            .json(&json!({
                "model": request.model,
                "messages": request.messages,
                "temperature": 0.2
            }))
            .send()
            .await
            .context("failed to call LM Studio chat endpoint")?
            .error_for_status()
            .context("LM Studio chat endpoint returned an error")?
            .json::<OpenAiChatResponse>()
            .await
            .context("failed to parse LM Studio chat response")?;

        let message = response
            .choices
            .into_iter()
            .next()
            .and_then(|choice| choice.message.content)
            .unwrap_or_default();

        Ok(ChatResponse {
            content: message,
            model: response.model,
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
        sink: ChatStreamSink,
    ) -> Result<ChatResponse> {
        let model = request.model.clone();
        let response = self
            .http
            .post(self.url("/chat/completions"))
            .bearer_auth(&self.api_key)
            .json(&json!({
                "model": request.model,
                "messages": request.messages,
                "temperature": 0.2,
                "stream": true
            }))
            .send()
            .await
            .context("failed to call LM Studio streaming chat endpoint")?
            .error_for_status()
            .context("LM Studio streaming chat endpoint returned an error")?;

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut message = String::new();
        let mut final_message: Option<String> = None;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("failed to read LM Studio stream chunk")?;
            buffer.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));

            while let Some(index) = buffer.find("\n\n") {
                let frame = buffer[..index].to_string();
                buffer = buffer[index + 2..].to_string();
                if let Some(event) = parse_sse_frame(&frame) {
                    if event.kind == "message.delta" {
                        if let Some(content) = event.content.as_deref() {
                            message.push_str(content);
                        }
                    }
                    if event.kind == "chat.end" {
                        final_message =
                            extract_final_message(&event.data).or_else(|| Some(message.clone()));
                    }
                    sink(event);
                }
            }
        }

        Ok(ChatResponse {
            content: final_message.unwrap_or(message),
            model: Some(model),
        })
    }

    async fn count_chat_tokens(&self, request: ChatRequest) -> Result<ContextUsageResult> {
        let message_count = request.messages.len();
        let response = self
            .http
            .post(self.rest_url("/api/v0/chat/completions"))
            .bearer_auth(&self.api_key)
            .json(&json!({
                "model": request.model,
                "messages": request.messages,
                "temperature": 0.0,
                "max_tokens": 0,
                "stream": false
            }))
            .send()
            .await
            .context("failed to call LM Studio context usage endpoint")?
            .error_for_status()
            .context("LM Studio context usage endpoint returned an error")?
            .json::<LmStudioChatUsageResponse>()
            .await
            .context("failed to parse LM Studio context usage response")?;

        Ok(ContextUsageResult {
            prompt_tokens: response
                .usage
                .as_ref()
                .map(|usage| usage.prompt_tokens)
                .unwrap_or(0),
            max_context_tokens: response
                .model_info
                .as_ref()
                .and_then(|info| info.context_length.or(info.max_context_length)),
            message_count,
            source: "lm_studio".to_string(),
        })
    }

    async fn embed(&self, input: Vec<String>) -> Result<Vec<Vec<f32>>> {
        let response = self
            .http
            .post(self.url("/embeddings"))
            .bearer_auth(&self.api_key)
            .json(&json!({ "input": input }))
            .send()
            .await
            .context("failed to call LM Studio embeddings endpoint")?
            .error_for_status()
            .context("LM Studio embeddings endpoint returned an error")?
            .json::<OpenAiEmbeddingResponse>()
            .await
            .context("failed to parse embeddings response")?;

        Ok(response
            .data
            .into_iter()
            .map(|item| item.embedding)
            .collect())
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let response = self
            .http
            .get(self.url("/models"))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .context("failed to call LM Studio models endpoint")?
            .error_for_status()
            .context("LM Studio models endpoint returned an error")?
            .json::<OpenAiModelsResponse>()
            .await
            .context("failed to parse models response")?;

        Ok(response
            .data
            .into_iter()
            .map(|model| ModelInfo {
                id: model.id,
                owned_by: model.owned_by,
            })
            .collect())
    }
}

fn parse_sse_frame(frame: &str) -> Option<ChatStreamEvent> {
    let mut event_type: Option<String> = None;
    let mut data_lines = Vec::new();
    for line in frame.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            event_type = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.trim_start().to_string());
        }
    }
    let data_text = data_lines.join("\n");
    if data_text.trim() == "[DONE]" {
        return Some(ChatStreamEvent {
            kind: "chat.end".to_string(),
            content: None,
            data: json!({}),
        });
    }
    let data = serde_json::from_str::<Value>(&data_text).unwrap_or_else(|_| json!({}));
    let content = extract_stream_content(&data).map(ToOwned::to_owned);
    let reasoning = extract_stream_reasoning(&data).map(ToOwned::to_owned);
    let kind = event_type.unwrap_or_else(|| {
        if content.is_some() {
            "message.delta".to_string()
        } else if reasoning.is_some() {
            "reasoning.delta".to_string()
        } else {
            "stream.event".to_string()
        }
    });
    Some(ChatStreamEvent {
        kind,
        content: content.or(reasoning),
        data,
    })
}

fn extract_stream_content(data: &Value) -> Option<&str> {
    data.get("content").and_then(Value::as_str).or_else(|| {
        data.get("choices")?
            .as_array()?
            .first()?
            .get("delta")?
            .get("content")?
            .as_str()
    })
}

fn extract_stream_reasoning(data: &Value) -> Option<&str> {
    data.get("reasoning_content")
        .and_then(Value::as_str)
        .or_else(|| data.get("reasoning").and_then(Value::as_str))
        .or_else(|| {
            let delta = data
                .get("choices")?
                .as_array()?
                .first()?
                .get("delta")?;
            delta
                .get("reasoning_content")
                .and_then(Value::as_str)
                .or_else(|| delta.get("reasoning").and_then(Value::as_str))
        })
}

fn extract_final_message(data: &Value) -> Option<String> {
    let output = data.get("result")?.get("output")?.as_array()?;
    let mut content = String::new();
    for item in output {
        if item.get("type").and_then(Value::as_str) == Some("message") {
            if let Some(part) = item.get("content").and_then(Value::as_str) {
                content.push_str(part);
            }
        }
    }
    (!content.is_empty()).then_some(content)
}

pub fn local_system_prompt() -> ChatMessage {
    ChatMessage {
        role: "system".to_string(),
        content: "You are Aegis, a local coding agent. Prefer small, reviewable changes. Use the daemon's read/search/git tools when you need project facts before answering, and use multiple tool rounds when that is necessary to finish the user request. When a task requires creating or modifying files, emit file.write tool calls; never claim that files were written unless a file.write observation has been returned. When the user approves a prior write request, immediately use the needed file.write tool call instead of restating the plan. When you need a tool, output only one tool call as exactly one JSON object containing tool and args, with no explanatory prose. The harness will execute approved tools in the background and return an observation; then continue the original task and only give the user the final answer when you are done. After writing files, do not paste the file contents back unless the user explicitly asks; briefly state what changed and any useful next command. In default permission mode, ask for approval before file-changing tools or terminal commands unless the latest user message clearly grants it. On Windows, prefer Windows-native commands; if the user asks for the Visual Studio C compiler, prefer discovering or using cl.exe over gcc. Keep responses deterministic and concise.".to_string(),
    }
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
    owned_by: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    model: Option<String>,
    choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingResponse {
    data: Vec<OpenAiEmbedding>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbedding {
    embedding: Vec<f32>,
}

#[derive(Debug, Deserialize)]
struct LmStudioChatUsageResponse {
    usage: Option<LmStudioUsage>,
    #[serde(default)]
    model_info: Option<LmStudioModelInfo>,
}

#[derive(Debug, Deserialize)]
struct LmStudioUsage {
    prompt_tokens: usize,
}

#[derive(Debug, Deserialize)]
struct LmStudioModelInfo {
    #[serde(default)]
    context_length: Option<usize>,
    #[serde(default)]
    max_context_length: Option<usize>,
}
