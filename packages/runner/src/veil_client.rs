use std::{collections::BTreeMap, fs, sync::OnceLock};

use futures_util::StreamExt;
use reqwest::{Certificate, Client, Identity, tls::Version};
use serde_json::{Map, Value, json};

use crate::{
    config::{ProviderConfig, provider_endpoint_url},
    events::now_iso,
    session::{EventSink, Session},
    tools::ToolCall,
    veil_request::chat_request_body,
    veil_retry::{
        MAX_RETRIES, VeilAttemptError, VeilAttemptInput, committed_output, emit_reconnected,
        emit_reconnecting, emit_session_rejected, reconnect_delay_ms, retry_after_from,
        retry_is_quiet, retryable_veil_failure, session_rejected, sleep_unless_aborted,
    },
    veil_tls::{expected_pin, pinned_tls_config, resolve_server_name},
};

/// reqwest's Display hides the useful cause — "error sending request for url
/// (...)" says nothing about *why*. The distinction between "operation timed
/// out" and "connection refused" lives in the error source chain.
fn describe_request_error(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}

fn provider_bearer(provider: &ProviderConfig) -> String {
    provider
        .api_key
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

static SHARED_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
static SHARED_HTTP_CLIENT_ERROR: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone, Default)]
pub struct VeilChatResult {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    /// Veil's size for the protected prefix it prepends. The runner strips
    /// system messages before sending, so this is the only way it can know.
    pub system_prompt_tokens: Option<u64>,
    /// False when the runtime has no tokenize endpoint and Veil fell back to a
    /// byte-length estimate.
    pub system_prompt_tokens_exact: bool,
    pub truncated_tool_arguments: bool,
}

pub struct VeilRequestOptions {
    pub max_output_tokens: u64,
    pub include_tools: bool,
}

pub async fn compact_context(
    session: &Session,
    previous_summary: Option<&str>,
    messages: &[Value],
    source_digest: &str,
    max_summary_tokens: u64,
) -> Result<String, String> {
    let (mut endpoint, host_header) = request_endpoint(&session.config.provider)?;
    endpoint.set_path("/api/internal/context/compact");
    endpoint.set_query(None);
    let route = session
        .config
        .provider
        .chat_endpoint_path
        .as_deref()
        .and_then(|path| path.split('/').nth(2))
        .unwrap_or("engineering");
    let body = json!({
        "route": route,
        "previousSummary": previous_summary.unwrap_or(""),
        "messages": messages,
        "maxSummaryTokens": max_summary_tokens.min(4_096),
        "sourceDigest": source_digest,
    });
    let client = shared_client(&session.config.provider)?;
    let mut request = client
        .post(endpoint)
        .header("Content-Type", "application/json");
    if let Some(host) = host_header {
        request = request.header("Host", host);
    }
    let bearer = provider_bearer(&session.config.provider);
    if !bearer.trim().is_empty() {
        request = request.bearer_auth(&bearer);
    }
    for (name, value) in &session.config.provider.headers {
        request = request.header(name, value);
    }
    let response = request.json(&body).send().await.map_err(|error| {
        format!(
            "context compaction failed: {}",
            describe_request_error(&error)
        )
    })?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| {
        format!(
            "context compaction failed: {}",
            describe_request_error(&error)
        )
    })?;
    if bytes.len() > 64 * 1024 {
        return Err("context compaction returned an oversized response".into());
    }
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "context compaction returned invalid JSON".to_owned())?;
    if !status.is_success() {
        let code = payload
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("context_compaction_failed");
        return Err(code.to_owned());
    }
    if payload.get("version").is_some()
        || payload.get("sourceDigest").and_then(Value::as_str) != Some(source_digest)
    {
        return Err("context compaction response did not match its source".into());
    }
    payload
        .get("summary")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "context compaction response did not contain a summary".to_owned())
}

/// Why a Veil-run web search produced no results.
#[derive(Debug)]
pub enum VeilWebSearchError {
    /// Veil answered with `writeCodedError`. The code is the contract between
    /// the two binaries; turning it into advice the model can act on is the
    /// caller's job, not the transport's.
    Coded(String),
    /// No coded answer ever arrived — the request failed, timed out, or came
    /// back as something this runner could not read.
    Transport(String),
}

/// A single search round trip has an end, unlike a chat stream, so it gets the
/// overall timeout the shared client deliberately does without. Veil serializes
/// its own outbound calls, so a queued search can legitimately wait a moment.
const WEB_SEARCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Asks Veil to run one public-web search. In server mode the query must not
/// leave the company boundary from this machine, so the runner never learns
/// which engine answered or what credential it used — it posts the query and
/// reads back whatever results Veil is willing to hand over.
pub async fn veil_web_search(
    session: &Session,
    query: &str,
) -> Result<Vec<Value>, VeilWebSearchError> {
    let (mut endpoint, host_header) =
        request_endpoint(&session.config.provider).map_err(VeilWebSearchError::Transport)?;
    endpoint.set_path("/api/web/search");
    endpoint.set_query(None);
    let client = shared_client(&session.config.provider).map_err(VeilWebSearchError::Transport)?;
    let mut request = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .timeout(WEB_SEARCH_TIMEOUT);
    if let Some(host) = host_header {
        request = request.header("Host", host);
    }
    let bearer = provider_bearer(&session.config.provider);
    if !bearer.trim().is_empty() {
        request = request.bearer_auth(&bearer);
    }
    for (name, value) in &session.config.provider.headers {
        request = request.header(name, value);
    }
    let response = request
        .json(&json!({ "query": query }))
        .send()
        .await
        .map_err(|error| VeilWebSearchError::Transport(describe_request_error(&error)))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| VeilWebSearchError::Transport(describe_request_error(&error)))?;
    // The route promises at most five titles and snippets. Anything this large
    // is not that answer, and reading it would spend the model's context on
    // whatever it actually is.
    if bytes.len() > 64 * 1024 {
        return Err(VeilWebSearchError::Transport(
            "the search response was oversized".to_owned(),
        ));
    }
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
        VeilWebSearchError::Transport("the search response was not JSON".to_owned())
    })?;
    if !status.is_success() {
        return Err(VeilWebSearchError::Coded(
            payload
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("web_search_unavailable")
                .to_owned(),
        ));
    }
    // The route always sends `results`, empty array and all, so a 200 without
    // one did not come from it — a proxy or captive sign-on answering an
    // expired session with its own cheerful JSON is the shape to expect. Read
    // leniently and that becomes "no hits", which tells the model the web was
    // searched and holds nothing on the subject. The search never ran.
    payload
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            VeilWebSearchError::Transport("the search response was not a result set".to_owned())
        })
}

#[path = "veil_image.rs"]
mod image;
pub use image::generate_image;

fn shared_client(provider: &ProviderConfig) -> Result<Client, String> {
    if let Some(client) = SHARED_HTTP_CLIENT.get() {
        return Ok(client.clone());
    }
    if let Some(error) = SHARED_HTTP_CLIENT_ERROR.get() {
        return Err(error.clone());
    }
    match client_for(provider) {
        Ok(client) => {
            let _ = SHARED_HTTP_CLIENT.set(client.clone());
            Ok(client)
        }
        Err(error) => {
            let _ = SHARED_HTTP_CLIENT_ERROR.set(error.clone());
            Err(error)
        }
    }
}

/// How long a connection attempt may take before it is treated as unreachable.
/// This bounds only the TCP and TLS handshake: a blackholed address behind a
/// dropped VPN would otherwise sit on the operating system's own connect
/// timeout, which is minutes. There is deliberately no overall request timeout
/// — a chat response is a long-lived stream, and liveness inside it is Veil's
/// stream idle timeout plus this client's own abort polling.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn client_for(provider: &ProviderConfig) -> Result<Client, String> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .min_tls_version(Version::TLS_1_2)
        .tls_info(true);
    if let Some(pin) = provider
        .mtls
        .as_ref()
        .and_then(|mtls| mtls.pinned_server_certificate_sha256.as_deref())
    {
        let mtls = provider.mtls.as_ref().expect("pin implies mTLS config");
        builder = builder.use_preconfigured_tls(pinned_tls_config(mtls, expected_pin(pin)?)?);
        if let Some(server_name) = &mtls.server_name {
            builder = resolve_server_name(builder, provider, server_name)?;
        }
        return builder.build().map_err(|error| error.to_string());
    }
    if let Some(mtls) = &provider.mtls {
        if let Some(server_name) = &mtls.server_name {
            builder = resolve_server_name(builder, provider, server_name)?;
        }
        if let Some(path) = &mtls.ca_path {
            let certificate = Certificate::from_pem(
                &fs::read(path).map_err(|error| format!("Unable to read mTLS CA: {error}"))?,
            )
            .map_err(|error| format!("Invalid mTLS CA: {error}"))?;
            builder = builder.add_root_certificate(certificate);
        }
        match (&mtls.cert_path, &mtls.key_path) {
            (Some(cert), Some(key)) => {
                let mut identity = fs::read(cert)
                    .map_err(|error| format!("Unable to read mTLS certificate: {error}"))?;
                identity.extend_from_slice(b"\n");
                identity.extend_from_slice(
                    &fs::read(key).map_err(|error| format!("Unable to read mTLS key: {error}"))?,
                );
                builder = builder.use_rustls_tls().identity(
                    Identity::from_pem(&identity)
                        .map_err(|error| format!("Invalid mTLS identity: {error}"))?,
                );
            }
            (None, None) => {}
            _ => return Err("mTLS certPath and keyPath must be configured together.".into()),
        }
    }
    builder.build().map_err(|error| error.to_string())
}

fn request_endpoint(provider: &ProviderConfig) -> Result<(url::Url, Option<String>), String> {
    let mut endpoint = provider_endpoint_url(provider)?;
    let Some(server_name) = provider
        .mtls
        .as_ref()
        .and_then(|mtls| mtls.server_name.as_deref())
    else {
        return Ok((endpoint, None));
    };
    let original_host = endpoint
        .host_str()
        .ok_or_else(|| "Provider endpoint has no host".to_owned())?;
    let host_header = match endpoint.port() {
        Some(port) => format!("{original_host}:{port}"),
        None => original_host.to_owned(),
    };
    endpoint
        .set_host(Some(server_name))
        .map_err(|_| "Invalid mTLS serverName override".to_owned())?;
    Ok((endpoint, Some(host_header)))
}

fn text_content(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .map(str::to_owned)
                    .or_else(|| part.get("text").and_then(Value::as_str).map(str::to_owned))
            })
            .collect(),
        _ => String::new(),
    }
}

fn append_content(result: &mut VeilChatResult, text: String) {
    if text.is_empty() {
        return;
    }
    result.content.push_str(&text);
}

// A provider may deliver the whole message outside the delta stream. Emit it
// once here so the desktop still receives the text, without duplicating what
// already streamed.
fn emit_completed_output(
    sink: &EventSink,
    session: &Session,
    result: &VeilChatResult,
    text_streamed: bool,
) {
    if text_streamed || result.content.is_empty() {
        return;
    }
    emit_visible_content(sink, session, result, &result.content);
}

fn emit_delta(sink: &EventSink, session: &Session, text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    sink.emit(json!({
        "type": "assistant.delta",
        "taskId": session.task_id,
        "text": text,
        "at": now_iso()
    }));
    true
}

fn emit_narration(sink: &EventSink, session: &Session, text: &str) -> bool {
    emit_progress(sink, session, text, None)
}

fn emit_progress(sink: &EventSink, session: &Session, text: &str, kind: Option<&str>) -> bool {
    if text.is_empty() {
        return false;
    }
    sink.emit(match kind {
        Some(kind) => json!({
            "type": "assistant.progress.delta",
            "taskId": session.task_id,
            "text": text,
            "kind": kind,
            "at": now_iso()
        }),
        None => json!({
            "type": "assistant.progress.delta",
            "taskId": session.task_id,
            "text": text,
            "at": now_iso()
        }),
    });
    true
}

fn emit_visible_content(
    sink: &EventSink,
    session: &Session,
    result: &VeilChatResult,
    content: &str,
) -> bool {
    if result.tool_calls.is_empty() {
        emit_delta(sink, session, content)
    } else {
        emit_narration(sink, session, content)
    }
}

fn emit_streamed(
    sink: &EventSink,
    session: &Session,
    result: &VeilChatResult,
    content: &str,
    reasoning: &str,
) -> bool {
    let mut streamed = false;
    if session.config.provider.reasoning_visible {
        streamed |= emit_progress(sink, session, reasoning, Some("thinking"));
    }
    streamed |= emit_visible_content(sink, session, result, content);
    streamed
}

fn reasoning_text(delta: &Map<String, Value>) -> String {
    for key in ["reasoning_content", "reasoning", "thinking"] {
        let text = text_content(delta.get(key));
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

fn append_veil_delta(
    result: &mut VeilChatResult,
    delta: &Map<String, Value>,
    partial: &mut BTreeMap<usize, (String, String, String)>,
) {
    for raw in delta
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(call) = raw.as_object() else {
            continue;
        };
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let function = call.get("function").and_then(Value::as_object);
        let existing = partial.entry(index).or_default();
        if let Some(id) = call.get("id").and_then(Value::as_str) {
            existing.0 = id.to_owned();
        }
        if let Some(name) = function
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
        {
            existing.1 = name.to_owned();
        }
        if let Some(arguments) = function
            .and_then(|value| value.get("arguments"))
            .and_then(Value::as_str)
        {
            existing.2.push_str(arguments);
        }
    }
    result.tool_calls = partial
        .iter()
        .map(|(index, (id, name, arguments))| ToolCall {
            id: if id.is_empty() {
                format!("tool-call-{index}")
            } else {
                id.clone()
            },
            name: name.clone(),
            arguments: Value::String(arguments.clone()),
            index: *index,
        })
        .collect();
}

// File bodies can take most of a turn to stream. Announce their preparation
// before execution without exposing partial arguments or claiming a write has
// succeeded. The normal requested/finished lifecycle still runs exactly once.
fn emit_tool_preparation(
    sink: &EventSink,
    session: &Session,
    partial: &BTreeMap<usize, (String, String, String)>,
    preparing: &mut std::collections::BTreeSet<String>,
) {
    if session.is_aborted() {
        return;
    }
    for (id, name, _) in partial.values() {
        let id = id.trim();
        // Wait for an actual id so a later id delta cannot strand a UI row.
        if id.is_empty()
            || !matches!(name.as_str(), "write" | "edit" | "apply_patch" | "artifact")
            || !preparing.insert(id.to_owned())
        {
            continue;
        }
        sink.emit(json!({
            "type": "tool.preparing",
            "taskId": session.task_id,
            "toolCallId": id,
            "toolKind": name,
            "at": now_iso(),
        }));
    }
}

fn process_veil_payload(
    payload: Value,
    result: &mut VeilChatResult,
    partial: &mut BTreeMap<usize, (String, String, String)>,
) -> (String, String) {
    if let Some(usage) = payload.get("usage") {
        update_usage(result, usage);
    }
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|values| values.first());
    let Some(choice) = choice else {
        return (String::new(), String::new());
    };
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        result.truncated_tool_arguments = true;
    }
    let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
        return (String::new(), String::new());
    };
    let content = text_content(delta.get("content"));
    append_content(result, content.clone());
    append_veil_delta(result, delta, partial);
    (content, reasoning_text(delta))
}

fn update_usage(result: &mut VeilChatResult, usage: &Value) {
    let total = usage.get("total_tokens").and_then(Value::as_u64);
    let prompt = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .or_else(|| {
            total
                .zip(result.completion_tokens)
                .map(|(total, completion)| total.saturating_sub(completion))
        });
    let completion = usage
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .or_else(|| {
            total
                .zip(prompt.or(result.prompt_tokens))
                .map(|(total, prompt)| total.saturating_sub(prompt))
        });
    result.prompt_tokens = prompt.or(result.prompt_tokens);
    result.completion_tokens = completion.or(result.completion_tokens);
    if let Some(system_prompt_tokens) = usage.get("system_prompt_tokens").and_then(Value::as_u64) {
        result.system_prompt_tokens = Some(system_prompt_tokens);
        result.system_prompt_tokens_exact = usage
            .get("system_prompt_tokens_exact")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }
}

fn complete_utf8_lines(buffer: &mut Vec<u8>, chunk: &[u8]) -> Result<Vec<String>, String> {
    const MAX_STREAM_LINE_BYTES: usize = 4 * 1024 * 1024;
    buffer.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut line = buffer.drain(..=newline).collect::<Vec<_>>();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > MAX_STREAM_LINE_BYTES {
            return Err("model stream line exceeded the 4 MiB limit".into());
        }
        lines.push(
            std::str::from_utf8(&line)
                .map_err(|_| "model stream contained invalid UTF-8".to_owned())?
                .to_owned(),
        );
    }
    if buffer.len() > MAX_STREAM_LINE_BYTES {
        return Err("model stream line exceeded the 4 MiB limit".into());
    }
    Ok(lines)
}

fn sse_data(line: &str) -> Option<&str> {
    line.strip_prefix("data:")
        .map(|data| data.strip_prefix(' ').unwrap_or(data))
}

fn veil_failure_message(status: Option<u16>, payload: Option<&Value>) -> String {
    let code = payload
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let upstream_status = payload
        .and_then(|value| value.get("upstreamStatus"))
        .and_then(Value::as_u64)
        .filter(|value| *value <= u16::MAX as u64);
    let description = match code {
        "model_service_rejected" => "the model service rejected the request",
        "model_service_timeout" => "the model service timed out",
        "model_service_invalid_response" => "the model service returned an invalid response",
        "model_service_stream_incomplete" => "the model service stream ended unexpectedly",
        "model_service_unavailable" => "the model service could not be reached",
        "context_overflow_preflight" => "context_overflow_preflight",
        "context_overflow_upstream" => "context_overflow_upstream",
        _ => "Veil could not complete the model request",
    };
    let mut details = Vec::new();
    if let Some(upstream_status) = upstream_status {
        details.push(format!("upstream status {upstream_status}"));
    }
    if let Some(status) = status {
        details.push(format!("Veil status {status}"));
    }
    if details.is_empty() {
        description.to_owned()
    } else {
        format!("{description} ({})", details.join(", "))
    }
}

/// An error frame Veil wrote into the stream, as the failure it describes.
///
/// Veil reports a runtime that went away after the stream opened — a reset
/// mid-answer, an idle timeout, an upstream that stopped short — as one of
/// these frames rather than as a status, because the status was already sent.
/// It is the same failure a dropped socket is, and as long as nothing has been
/// committed it is worth the same retry; the caller decides that part.
fn veil_stream_error(line: &str) -> Option<VeilAttemptError> {
    let data = sse_data(line)?;
    let payload = serde_json::from_str::<Value>(data).ok()?;
    payload.get("error")?;
    let message = format!(
        "model request failed: {}",
        veil_failure_message(None, Some(&payload))
    );
    let code = payload.get("code").and_then(Value::as_str).unwrap_or("");
    Some(
        if matches!(
            code,
            "model_service_stream_incomplete"
                | "model_service_unavailable"
                | "model_service_timeout"
        ) {
            VeilAttemptError::retryable(message)
        } else {
            VeilAttemptError::final_failure(message)
        },
    )
}

fn process_veil_line(
    line: &str,
    result: &mut VeilChatResult,
    partial: &mut BTreeMap<usize, (String, String, String)>,
) -> Result<(bool, String, String), String> {
    let Some(data) = sse_data(line) else {
        return Ok((false, String::new(), String::new()));
    };
    if data.trim() == "[DONE]" {
        return Ok((true, String::new(), String::new()));
    }
    let payload = serde_json::from_str::<Value>(data)
        .map_err(|_| "Veil stream contained invalid JSON".to_owned())?;
    let (content, reasoning) = process_veil_payload(payload, result, partial);
    Ok((false, content, reasoning))
}

fn fill_missing_tool_call_ids(calls: &mut [ToolCall]) {
    for call in calls {
        let id = if call.id.trim().is_empty() {
            format!("tool-call-{}", call.index)
        } else {
            call.id.trim().to_owned()
        };
        call.id = id;
    }
}

pub(crate) fn encoded_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) != Some("system"))
        .cloned()
        .collect()
}

pub async fn stream_veil_chat(
    session: &Session,
    sink: &EventSink,
    messages: &[Value],
    tools: &[Value],
    options: VeilRequestOptions,
) -> Result<VeilChatResult, String> {
    let VeilRequestOptions {
        max_output_tokens,
        include_tools,
    } = options;
    if session.is_aborted() {
        return Err("model request aborted".into());
    }
    let (endpoint, host_header) = request_endpoint(&session.config.provider)?;
    let path = endpoint.path().trim_end_matches('/').to_ascii_lowercase();
    if !matches!(
        path.as_str(),
        "/api/engineering/chat" | "/api/marketing/chat" | "/api/sales/chat"
    ) {
        return Err("model request must target an approved Veil chat route".into());
    }
    let body = chat_request_body(
        &session.config,
        messages,
        tools,
        max_output_tokens,
        include_tools,
    );

    let attempt_input = VeilAttemptInput {
        endpoint,
        host_header,
        body,
    };
    // Retries taken so far, how many of them went unannounced, and whether the
    // composer has been told. The quiet ones are subtracted from what the user
    // is shown, so the count on screen starts at 1 and ends at the number of
    // waits they could actually see.
    let mut retries = 0_u32;
    let mut quiet_retries = 0_u32;
    let mut shown = false;
    loop {
        match attempt_veil_chat(session, sink, &attempt_input).await {
            Ok(result) => {
                if shown {
                    emit_reconnected(session, sink, retries);
                }
                return Ok(result);
            }
            Err(error) => {
                // Three separate reasons not to try again, and they do not mean
                // the same thing. Committed means the caller could already have
                // acted on this turn, so repeating it would duplicate work
                // rather than recover it. Not retryable means the failure will
                // answer the same way next time. Out of attempts means the
                // server is not coming back on a timescale anyone will wait for.
                if error.committed
                    || !error.retryable
                    || retries >= MAX_RETRIES
                    || session.is_aborted()
                {
                    return Err(error.message);
                }
                retries += 1;
                let delay_ms = reconnect_delay_ms(retries, shown, error.retry_after_ms);
                if retry_is_quiet(retries, shown, delay_ms) {
                    quiet_retries += 1;
                } else {
                    shown = true;
                    emit_reconnecting(
                        session,
                        sink,
                        retries - quiet_retries,
                        MAX_RETRIES - quiet_retries,
                        delay_ms,
                    );
                }
                if !sleep_unless_aborted(session, delay_ms).await {
                    return Err("model request aborted".into());
                }
            }
        }
    }
}

/// One request to Veil, from opening the connection to the completion marker.
async fn attempt_veil_chat(
    session: &Session,
    sink: &EventSink,
    input: &VeilAttemptInput,
) -> Result<VeilChatResult, VeilAttemptError> {
    let VeilAttemptInput {
        endpoint,
        host_header,
        body,
    } = input;
    // A misconfigured provider answers the same way every time.
    let client =
        shared_client(&session.config.provider).map_err(VeilAttemptError::final_failure)?;
    let mut request = client
        .post(endpoint.clone())
        .header("Content-Type", "application/json");
    if let Some(host) = host_header.as_deref() {
        request = request.header("Host", host);
    }
    let bearer = provider_bearer(&session.config.provider);
    if !bearer.trim().is_empty() {
        request = request.bearer_auth(&bearer);
    }
    for (name, value) in &session.config.provider.headers {
        request = request.header(name, value);
    }
    let send_future = request.json(&body).send();
    tokio::pin!(send_future);
    let response = loop {
        if session.is_aborted() {
            return Err(VeilAttemptError::final_failure("model request aborted"));
        }
        tokio::select! {
            result = &mut send_future => {
                // Never reaching the server is the case retrying exists for.
                break result.map_err(|error| VeilAttemptError::retryable(format!(
                    "model request failed: {}",
                    describe_request_error(&error)
                )))?;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {}
        }
    };
    let status = response.status();
    if !status.is_success() {
        // Read before the body is consumed: a loaded gateway answering 429 or
        // 503 usually says when to come back, and that beats guessing.
        let retry_after = retry_after_from(&response);
        let text = response.text().await.unwrap_or_default();
        let payload = serde_json::from_str::<Value>(&text).ok();
        let message = format!(
            "model request failed: {}",
            veil_failure_message(Some(status.as_u16()), payload.as_ref())
        );
        if session_rejected(status.as_u16(), payload.as_ref()) {
            emit_session_rejected(session, sink);
            return Err(VeilAttemptError::retryable(message));
        }
        return Err(
            if retryable_veil_failure(status.as_u16(), payload.as_ref()) {
                VeilAttemptError::retryable(message).after(retry_after)
            } else {
                VeilAttemptError::final_failure(message)
            },
        );
    }
    let mut result = VeilChatResult::default();
    let mut partial = BTreeMap::new();
    let mut preparing = std::collections::BTreeSet::new();
    let mut buffer = Vec::new();
    let mut completed = false;
    let mut text_streamed = false;
    let mut stream = response.bytes_stream();
    loop {
        if session.is_aborted() {
            return Err(VeilAttemptError::final_failure("model request aborted"));
        }
        let chunk =
            match tokio::time::timeout(std::time::Duration::from_millis(25), stream.next()).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => continue,
            };
        // A connection dropped mid-stream is still recoverable for as long as
        // the turn has produced nothing the caller could have acted on, so the
        // question is asked again at every message rather than assumed once.
        let committed = committed_output(&result, &partial, text_streamed);
        let chunk = chunk.map_err(|error| {
            VeilAttemptError::retryable(describe_request_error(&error)).committed_if(committed)
        })?;
        for line in complete_utf8_lines(&mut buffer, &chunk)
            .map_err(|error| VeilAttemptError::final_failure(error).committed_if(committed))?
        {
            if let Some(error) = veil_stream_error(&line) {
                return Err(error.committed_if(committed));
            }
            let (line_completed, content, reasoning) =
                process_veil_line(&line, &mut result, &mut partial).map_err(|error| {
                    VeilAttemptError::final_failure(error).committed_if(committed)
                })?;
            text_streamed |= emit_streamed(sink, session, &result, &content, &reasoning);
            emit_tool_preparation(sink, session, &partial, &mut preparing);
            if line_completed {
                completed = true;
            }
        }
    }
    let committed = committed_output(&result, &partial, text_streamed);
    let trailing = std::str::from_utf8(&buffer).map_err(|_| {
        VeilAttemptError::final_failure("model stream ended with invalid UTF-8")
            .committed_if(committed)
    })?;
    if !trailing.trim().is_empty() {
        let trailing = trailing.trim_end_matches(['\r', '\n']);
        if let Some(error) = veil_stream_error(trailing) {
            return Err(error.committed_if(committed));
        }
        let (line_completed, content, reasoning) =
            process_veil_line(trailing, &mut result, &mut partial)
                .map_err(|error| VeilAttemptError::final_failure(error).committed_if(committed))?;
        text_streamed |= emit_streamed(sink, session, &result, &content, &reasoning);
        emit_tool_preparation(sink, session, &partial, &mut preparing);
        if line_completed {
            completed = true;
        }
    }
    if !completed {
        // A stream that stopped short of its marker having produced nothing is
        // the server going away mid-answer, which is worth another attempt.
        return Err(
            VeilAttemptError::retryable("model stream ended before the completion marker")
                .committed_if(committed_output(&result, &partial, text_streamed)),
        );
    }
    fill_missing_tool_call_ids(&mut result.tool_calls);
    if result.truncated_tool_arguments {
        for call in &mut result.tool_calls {
            call.arguments = Value::String("{\"__umbratic_truncated_tool_arguments__\":".into());
        }
    }
    emit_completed_output(sink, session, &result, text_streamed);
    Ok(result)
}

#[cfg(test)]
#[path = "veil_client_tests.rs"]
mod tests;
