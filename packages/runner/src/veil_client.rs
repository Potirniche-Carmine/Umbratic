use std::{collections::BTreeMap, fs, sync::OnceLock};

use futures_util::StreamExt;
use reqwest::{Certificate, Client, Identity, tls::Version};
use serde_json::{Map, Value, json};

use crate::{
    config::{ProviderConfig, provider_endpoint_url},
    events::now_iso,
    response_output::{SafeAssistantText, looks_like_unstructured_tool_call},
    session::{EventSink, Session},
    tools::ToolCall,
    veil_tls::{expected_pin, pinned_tls_config, resolve_server_name, verify_certificate_pin},
};

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
    /// The run's validated bucket selector. Protected control metadata, not
    /// prompt text: Veil renders the playbook from its own catalog.
    pub harness_bucket: Option<String>,
}

/// A validated classifier decision for the active run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrientDecision {
    pub bucket: String,
    /// `None` for `direct_answer`, and for a guided bucket whose sentence
    /// failed validation — the sentence is the optional part of the decision.
    pub summary_sentence: Option<String>,
}

/// The bucket that suppresses the playbook and the status sentence entirely.
pub const DIRECT_ANSWER_BUCKET: &str = "direct_answer";

const MAX_ORIENT_REQUEST_BYTES: usize = 32 * 1024;
const ORIENT_HEAD_TAIL_BYTES: usize = 16 * 1024;
const MAX_SUMMARY_SENTENCE_RUNES: usize = 240;
const ORIENT_OMISSION_MARKER: &str = "\n[... request text omitted ...]\n";

/// Truncates to a UTF-8-safe head and tail so a long paste still classifies on
/// its actual intent rather than being rejected.
fn bounded_request_text(text: &str) -> String {
    if text.len() <= MAX_ORIENT_REQUEST_BYTES {
        return text.to_owned();
    }
    let mut head_end = ORIENT_HEAD_TAIL_BYTES.min(text.len());
    while !text.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = text.len().saturating_sub(ORIENT_HEAD_TAIL_BYTES);
    while !text.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    if tail_start < head_end {
        tail_start = head_end;
    }
    format!(
        "{}{ORIENT_OMISSION_MARKER}{}",
        &text[..head_end],
        &text[tail_start..]
    )
}

/// The runner-side check on the status sentence.
///
/// Veil owns the bucket catalog and does the precise "no bucket id as a
/// standalone token" check. The runner cannot repeat that check without the
/// catalog, so it enforces a strict superset instead: every bucket id contains
/// an underscore, so rejecting any sentence containing one guarantees no id can
/// reach a user-visible event. The sentence goes into exported telemetry, so a
/// failing sentence is dropped whole rather than scrubbed — but it costs only
/// the sentence, never the bucket.
fn valid_summary_sentence(sentence: &str) -> bool {
    !sentence.is_empty()
        && !sentence.contains('\n')
        && !sentence.contains('\r')
        && !sentence.contains('_')
        && sentence.chars().count() <= MAX_SUMMARY_SENTENCE_RUNES
        && (sentence.ends_with('.') || sentence.ends_with('!'))
}

/// Classifies one accepted run. Orient can only add behavior: every failure
/// path returns `Err`, and the caller then runs exactly today's chat path.
pub async fn orient_request(
    session: &Session,
    request_text: &str,
    previous_bucket: Option<&str>,
) -> Result<OrientDecision, String> {
    let request_text = bounded_request_text(request_text);
    if request_text.trim().is_empty() {
        return Err("orient skipped for a blank request".into());
    }
    let (mut endpoint, host_header) = request_endpoint(&session.config.provider)?;
    // The Veil route allowlist is widened only here. Ordinary chat still accepts
    // only the three chat paths.
    endpoint.set_path("/api/internal/orient");
    endpoint.set_query(None);
    let route = provider_endpoint_url(&session.config.provider)?
        .path()
        .trim_start_matches("/api/")
        .trim_end_matches('/')
        .to_owned();
    let body = json!({
        "route": route,
        "requestText": request_text,
        "previousBucket": previous_bucket.unwrap_or(""),
    });
    let timeout = match session.config.provider.mode {
        crate::config::ProviderMode::Server => std::time::Duration::from_secs(3),
        crate::config::ProviderMode::Local => std::time::Duration::from_secs(10),
    };
    let client = shared_client(&session.config.provider)?;
    let mut request = client
        .post(endpoint)
        .timeout(timeout)
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
    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("orient failed: {error}"))?;
    verify_certificate_pin(&session.config.provider, &response)?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("orient failed: {error}"))?;
    if bytes.len() > 8 * 1024 {
        return Err("orient returned an oversized response".into());
    }
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|_| "orient returned invalid JSON".to_owned())?;
    if !status.is_success() {
        return Err(payload
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("invalid_orient_decision")
            .to_owned());
    }
    let Some(object) = payload.as_object() else {
        return Err("invalid_orient_decision".into());
    };
    if object
        .keys()
        .any(|key| key != "bucket" && key != "summarySentence")
    {
        return Err("invalid_orient_decision".into());
    }
    let bucket = object
        .get("bucket")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "invalid_orient_decision".to_owned())?
        .to_owned();
    if bucket == DIRECT_ANSWER_BUCKET {
        return Ok(OrientDecision {
            bucket,
            summary_sentence: None,
        });
    }
    // The sentence is optional: a missing or invalid one is dropped and the
    // validated bucket still guides the run.
    let sentence = match object.get("summarySentence") {
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            valid_summary_sentence(trimmed).then(|| trimmed.to_owned())
        }
        _ => None,
    };
    Ok(OrientDecision {
        bucket,
        summary_sentence: sentence,
    })
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
    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("context compaction failed: {error}"))?;
    verify_certificate_pin(&session.config.provider, &response)?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("context compaction failed: {error}"))?;
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

fn client_for(provider: &ProviderConfig) -> Result<Client, String> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
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
    if looks_like_unstructured_tool_call(&result.content) {
        return;
    }
    emit_delta(sink, session, &result.content);
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

fn process_veil_payload(
    payload: Value,
    result: &mut VeilChatResult,
    partial: &mut BTreeMap<usize, (String, String, String)>,
) -> String {
    if let Some(usage) = payload.get("usage") {
        update_usage(result, usage);
    }
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|values| values.first());
    let Some(choice) = choice else {
        return String::new();
    };
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        result.truncated_tool_arguments = true;
    }
    let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
        return String::new();
    };
    let content = text_content(delta.get("content"));
    append_content(result, content.clone());
    append_veil_delta(result, delta, partial);
    content
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

fn veil_stream_error(line: &str) -> Option<String> {
    let data = sse_data(line)?;
    let payload = serde_json::from_str::<Value>(data).ok()?;
    payload.get("error")?;
    Some(format!(
        "model request failed: {}",
        veil_failure_message(None, Some(&payload))
    ))
}

fn process_veil_line(
    line: &str,
    result: &mut VeilChatResult,
    partial: &mut BTreeMap<usize, (String, String, String)>,
) -> Result<(bool, String), String> {
    let Some(data) = sse_data(line) else {
        return Ok((false, String::new()));
    };
    if data.trim() == "[DONE]" {
        return Ok((true, String::new()));
    }
    let payload = serde_json::from_str::<Value>(data)
        .map_err(|_| "Veil stream contained invalid JSON".to_owned())?;
    let content = process_veil_payload(payload, result, partial);
    Ok((false, content))
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

fn encoded_messages(messages: &[Value]) -> Vec<Value> {
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
        harness_bucket,
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
    let mut body = json!({
        "messages": encoded_messages(messages),
        "stream": true,
        "max_output_tokens": max_output_tokens
    });
    let object = body.as_object_mut().unwrap();
    if !session.config.skills.is_empty() {
        object.insert("skills".into(), Value::Array(session.config.skills.iter().map(|skill| json!({ "id":skill.id, "name":skill.name, "description":skill.description, "source":skill.source, "paths":skill.paths })).collect()));
    }
    if include_tools && !tools.is_empty() {
        object.insert("tools".into(), Value::Array(tools.to_vec()));
    }
    if let Some(bucket) = harness_bucket.as_deref().filter(|value| !value.is_empty()) {
        object.insert("harness_bucket".into(), Value::String(bucket.to_owned()));
    }
    let client = shared_client(&session.config.provider)?;
    let mut request = client
        .post(endpoint.clone())
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
    let send_future = request.json(&body).send();
    tokio::pin!(send_future);
    let response = loop {
        if session.is_aborted() {
            return Err("model request aborted".into());
        }
        tokio::select! {
            result = &mut send_future => {
                break result.map_err(|error| format!("model request failed: {error}"))?;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {}
        }
    };
    verify_certificate_pin(&session.config.provider, &response)?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let payload = serde_json::from_str::<Value>(&text).ok();
        return Err(format!(
            "model request failed: {}",
            veil_failure_message(Some(status.as_u16()), payload.as_ref())
        ));
    }
    let mut result = VeilChatResult::default();
    let mut partial = BTreeMap::new();
    let mut buffer = Vec::new();
    let mut completed = false;
    let mut text_streamed = false;
    let mut safe_output = SafeAssistantText::default();
    let mut stream = response.bytes_stream();
    loop {
        if session.is_aborted() {
            return Err("model request aborted".into());
        }
        let chunk =
            match tokio::time::timeout(std::time::Duration::from_millis(25), stream.next()).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => continue,
            };
        let chunk = chunk.map_err(|error| error.to_string())?;
        for line in complete_utf8_lines(&mut buffer, &chunk)? {
            if let Some(error) = veil_stream_error(&line) {
                return Err(error);
            }
            let (line_completed, content) = process_veil_line(&line, &mut result, &mut partial)?;
            text_streamed |= emit_delta(sink, session, &safe_output.push(&content));
            if line_completed {
                completed = true;
            }
        }
    }
    let trailing = std::str::from_utf8(&buffer)
        .map_err(|_| "model stream ended with invalid UTF-8".to_owned())?;
    if !trailing.trim().is_empty() {
        let trailing = trailing.trim_end_matches(['\r', '\n']);
        if let Some(error) = veil_stream_error(trailing) {
            return Err(error);
        }
        let (line_completed, content) = process_veil_line(trailing, &mut result, &mut partial)?;
        text_streamed |= emit_delta(sink, session, &safe_output.push(&content));
        if line_completed {
            completed = true;
        }
    }
    if !completed {
        return Err("model stream ended before the completion marker".into());
    }
    text_streamed |= emit_delta(sink, session, &safe_output.finish());
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
mod tests {
    use super::*;
    use crate::config::MtlsConfig;
    #[test]
    fn tool_deltas_accumulate_by_index() {
        let mut result = VeilChatResult::default();
        let mut calls = BTreeMap::new();
        append_veil_delta(&mut result, json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{\"pa"}}]}).as_object().unwrap(), &mut calls);
        append_veil_delta(
            &mut result,
            json!({"tool_calls":[{"index":0,"function":{"arguments":"th\":\"README.md\"}"}}]})
                .as_object()
                .unwrap(),
            &mut calls,
        );
        assert_eq!(
            result.tool_calls[0].arguments.as_str(),
            Some("{\"path\":\"README.md\"}")
        );
    }
    #[test]
    fn split_multibyte_utf8_is_preserved_until_a_complete_line() {
        let source = "data: {\"choices\":[{\"delta\":{\"content\":\"café\"}}]}\n";
        let bytes = source.as_bytes();
        let split = source.find('é').unwrap() + 1;
        let mut buffer = Vec::new();
        assert!(
            complete_utf8_lines(&mut buffer, &bytes[..split])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            complete_utf8_lines(&mut buffer, &bytes[split..]).unwrap(),
            [source.trim_end()]
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn sse_data_accepts_optional_space_after_field_name() {
        assert_eq!(sse_data("data: [DONE]"), Some("[DONE]"));
        assert_eq!(sse_data("data:[DONE]"), Some("[DONE]"));
        assert_eq!(sse_data("event: error"), None);
    }

    #[test]
    fn veil_failures_are_specific_without_echoing_untrusted_response_bodies() {
        let payload = json!({
            "error": "provider leaked prompt content",
            "code": "model_service_rejected",
            "upstreamStatus": 500
        });
        let message = veil_failure_message(Some(502), Some(&payload));
        assert_eq!(
            message,
            "the model service rejected the request (upstream status 500, Veil status 502)"
        );
        assert!(!message.contains("leaked"));

        let stream =
            "data: {\"error\":\"hidden detail\",\"code\":\"model_service_stream_incomplete\"}";
        assert_eq!(
            veil_stream_error(stream).as_deref(),
            Some("model request failed: the model service stream ended unexpectedly")
        );
    }

    #[test]
    fn total_only_usage_completes_a_partial_provider_measurement() {
        let mut result = VeilChatResult {
            prompt_tokens: Some(1200),
            ..VeilChatResult::default()
        };
        update_usage(&mut result, &json!({"total_tokens": 1300}));
        assert_eq!(result.prompt_tokens, Some(1200));
        assert_eq!(result.completion_tokens, Some(100));
        // A runtime that reports no protected-prefix size leaves the runner on
        // its configured stand-in rather than on a zero.
        assert_eq!(result.system_prompt_tokens, None);

        let mut result = VeilChatResult {
            completion_tokens: Some(100),
            ..VeilChatResult::default()
        };
        update_usage(&mut result, &json!({"total_tokens": 1300}));
        assert_eq!(result.prompt_tokens, Some(1200));
        assert_eq!(result.completion_tokens, Some(100));

        update_usage(
            &mut result,
            &json!({"prompt_tokens": 1200, "completion_tokens": 100, "system_prompt_tokens": 3187, "system_prompt_tokens_exact": true}),
        );
        assert_eq!(result.system_prompt_tokens, Some(3187));
        assert!(result.system_prompt_tokens_exact);

        // A size without an exactness claim is treated as an estimate.
        let mut result = VeilChatResult::default();
        update_usage(&mut result, &json!({"system_prompt_tokens": 800}));
        assert_eq!(result.system_prompt_tokens, Some(800));
        assert!(!result.system_prompt_tokens_exact);
    }

    #[test]
    fn complete_stream_lines_reject_invalid_utf8() {
        let mut buffer = Vec::new();
        assert_eq!(
            complete_utf8_lines(&mut buffer, b"data: \xff\n").unwrap_err(),
            "model stream contained invalid UTF-8"
        );
    }

    #[test]
    fn stream_lines_and_json_are_bounded_and_strict() {
        let mut buffer = Vec::new();
        assert!(
            complete_utf8_lines(&mut buffer, &vec![b'x'; 4 * 1024 * 1024 + 1])
                .unwrap_err()
                .contains("4 MiB")
        );
        buffer.clear();
        let mut complete_oversized = vec![b'x'; 4 * 1024 * 1024 + 1];
        complete_oversized.push(b'\n');
        assert!(
            complete_utf8_lines(&mut buffer, &complete_oversized)
                .unwrap_err()
                .contains("4 MiB")
        );
        let mut result = VeilChatResult::default();
        let mut partial = BTreeMap::new();
        assert_eq!(
            process_veil_line("data: not-json", &mut result, &mut partial).unwrap_err(),
            "Veil stream contained invalid JSON"
        );
    }

    #[test]
    fn missing_tool_call_ids_are_created_without_hiding_duplicates() {
        let mut calls = vec![
            ToolCall {
                id: "same".into(),
                name: "read".into(),
                arguments: json!({}),
                index: 0,
            },
            ToolCall {
                id: "same".into(),
                name: "read".into(),
                arguments: json!({}),
                index: 1,
            },
            ToolCall {
                id: "".into(),
                name: "read".into(),
                arguments: json!({}),
                index: 2,
            },
        ];
        fill_missing_tool_call_ids(&mut calls);
        assert_eq!(calls[0].id, calls[1].id);
        assert_eq!(calls[2].id, "tool-call-2");
    }

    fn provider_with_mtls(mtls: MtlsConfig) -> ProviderConfig {
        ProviderConfig {
            id: "company-endpoint".into(),
            name: "test".into(),
            base_url: "https://127.0.0.1".into(),
            mode: crate::config::ProviderMode::Local,
            chat_endpoint_path: Some("/v1/chat/completions".into()),
            api_key: std::sync::Arc::new(std::sync::RwLock::new(String::new())),
            model_id: "test".into(),
            parallel_tool_calls: false,
            vision: false,
            reasoning: false,
            headers: BTreeMap::new(),
            mtls: Some(mtls),
        }
    }

    #[test]
    fn mtls_pem_identity_requires_a_certificate_and_key_pair() {
        let cert_only = provider_with_mtls(MtlsConfig {
            cert_path: Some("client.pem".into()),
            ..MtlsConfig::default()
        });
        assert!(
            client_for(&cert_only)
                .unwrap_err()
                .contains("certPath and keyPath")
        );
    }
}
